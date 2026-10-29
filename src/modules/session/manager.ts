// Менеджер сессий: создание/удаление/переименование, активная, изоляция, лимиты.
import type { SessionMeta, SessionMessage } from "./types";
import type { SessionStore, SessionLogEntry } from "./store";
import { t } from "../../i18n/index";
import type { SessionIsolationConfig, SessionContext } from "../../modules/security/session-isolation";
import {
  createSessionContext,
  DEFAULT_SESSION_ISOLATION,
} from "../../modules/security/session-isolation";
import type { SessionEncryptionConfig } from "../../config/types";
import { normalizeSecurityOverrides } from "./security-overrides";
import { isEmptySession, pruneEmptySessions } from "./prune";
import { autoPruneSessions, scheduleAutoPrune } from "./auto-prune";
import { newSessionId } from "./id";
import type { SessionManagerOptions } from "./manager-options";

export type { SessionManagerOptions } from "./manager-options";

/** Менеджер: активная сессия, контексты изоляции, maxSessions, prune пустых. */
export class SessionManager {
  private store: SessionStore;
  private activeId: string | null = null;
  private options: SessionManagerOptions;
  /** Контексты сессий (для изоляции) по id */
  private sessionContexts: Map<string, SessionContext> = new Map();
  /**
   * Слушатели переименования. У pinned-сиблинга (`forkPinned`) свой список, а
   * переименование сиблинга дополнительно уведомляет главного менеджера: иначе
   * отписка одного раннера снимала бы подписку главного (аудит §7.16).
   */
  private renameListeners: Array<(meta: SessionMeta) => void> = [];
  /** Главный менеджер (для сиблинга) — его подписчиков тоже уведомляем. */
  private parentManager?: SessionManager;
  /** Сессии с живыми раннерами — их нельзя вычищать (аудит §7.15). */
  private busySessions = new Set<string>();
  /** Один запланированный прогон автоочистки на менеджер. */
  private pruneState = { scheduled: false };

  constructor(store: SessionStore, options: SessionManagerOptions) {
    this.store = store;
    this.options = options;

    // Шифрование — если настроено
    if (options.encryption) {
      this.store.updateEncryption(options.encryption);
    }
  }

  /** Включено ли шифрование файлов сессий. */
  isEncryptionEnabled(): boolean {
    return this.store.isEncryptionEnabled();
  }

  /** Обновить конфиг шифрования. */
  updateEncryption(config: SessionEncryptionConfig): void {
    this.store.updateEncryption(config);
    this.options.encryption = config;
  }

  /** Создать сессию (имя/оверрайды/внешний ключ опциональны), сделать активной. */
  create(
    name?: string,
    securityOverrides?: SessionMeta["securityOverrides"],
    externalRef?: string,
  ): SessionMeta {
    const now = new Date().toISOString();
    const id = newSessionId();
    const sessionName = name || t("session.default_name");
    const meta: SessionMeta = {
      id,
      name: sessionName,
      nameSource: name ? "manual" : "default",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model: this.options.model,
      contextWindow: this.options.contextWindow,
      projectDir: this.options.projectDir,
      securityOverrides,
      ...(externalRef ? { externalRef } : {}),
    };
    this.store.saveMeta(id, meta);
    this.activeId = id;
    this.scheduleEnforceMaxSessions();
    // Авто-прунинг пустых сессий из create() убран: в web параллельные вкладки
    // держат пустые сессии, и создание новой затирало бы их (вкладки уходили в
    // dead). Чистка — явная команда `session prune` (CLI/REPL).

    // Контекст сессии
    const context = createSessionContext(
      id,
      this.options.projectDir,
      this.options.isolation,
      normalizeSecurityOverrides(securityOverrides),
    );
    this.sessionContexts.set(id, context);

    return meta;
  }

  /** Список сессий. */
  list(): SessionMeta[] {
    return this.store.listSessions();
  }

  /** Мета по id (null — нет). */
  get(id: string): SessionMeta | null {
    return this.store.loadMeta(id);
  }

  /** Удалить сессию (+ контекст, сброс активной). */
  delete(id: string): void {
    // Чистим контекст сессии
    const context = this.sessionContexts.get(id);
    if (context) {
      // Реально temp-файлы тут не чистятся (нет реализации)
      this.sessionContexts.delete(id);
    }

    this.store.deleteSession(id);
    if (this.activeId === id) {
      this.activeId = null;
    }
  }

  /** Переименовать сессию (источник имени: auto/manual). */
  rename(id: string, name: string, source: "auto" | "manual" = "manual"): void {
    const meta = this.store.loadMeta(id);
    if (!meta) throw new Error(t("session.not_found", { id }));
    meta.name = name;
    meta.nameSource = source;
    this.store.saveMeta(id, meta);
    // Подписчики сиблинга И главного менеджера: переименование в форке —
    // тоже событие для интерфейса.
    for (const cb of [...this.renameListeners, ...(this.parentManager?.renameListeners ?? [])]) {
      try {
        cb(meta);
      } catch {
        // fail-open: подписчик (UI-бродкаст) не должен ронять переименование
      }
    }
  }

  /** Подписка на переименование любой сессии (в т.ч. через pinned-сиблинг).
   *  Возвращает функцию отписки. */
  onRename(cb: (meta: SessionMeta) => void): () => void {
    this.renameListeners.push(cb);
    return () => {
      const i = this.renameListeners.indexOf(cb);
      if (i >= 0) this.renameListeners.splice(i, 1);
    };
  }

  /**
   * Обновить окно/модель после probe/reconfigure. Пишет мету активной сессии И
   * дефолты новых (`create()` берёт их из `options`, а не из конфига). Fail-open.
   */
  setEffectiveContext(contextWindow: number, model?: string): void {
    // Дефолты новых сессий: без этого они записывали стартовую модель.
    this.options.contextWindow = contextWindow;
    if (model) this.options.model = model;
    if (!this.activeId) return;
    const meta = this.store.loadMeta(this.activeId);
    if (!meta) return;
    meta.contextWindow = contextWindow;
    if (model) meta.model = model;
    meta.updatedAt = new Date().toISOString();
    this.store.saveMeta(this.activeId, meta);
  }

  /**
   * Обновляет `updatedAt` активной сессии без изменения содержимого. Вызывается
   * в конце хода: `updatedAt` иначе двигает только `appendMessage`, поэтому ход
   * без сообщений (оборван на входе) оставлял мету со временем старта.
   * Fail-open: нет активной сессии — no-op.
   */
  touch(): void {
    if (!this.activeId) return;
    const meta = this.store.loadMeta(this.activeId);
    if (!meta) return;
    meta.updatedAt = new Date().toISOString();
    this.store.saveMeta(this.activeId, meta);
  }

  /** Пустая ли сессия (нет user-сообщения с текстом). Fail-open: ошибки чтения — непустая. */
  isEmptySession(id: string): boolean {
    return isEmptySession(this.store, id, (sid) => this.getHistory(sid));
  }

  /** Удалить все пустые сессии, кроме `excludeId`. Вернуть удалённые id. Не бросает. */
  pruneEmpty(excludeId?: string): string[] {
    return pruneEmptySessions(this.store, excludeId, (id) => this.delete(id));
  }

  /** Id активной сессии (null — нет). */
  getActive(): string | null {
    return this.activeId;
  }

  /** Мета активной сессии (null — нет). */
  getActiveMeta(): SessionMeta | null {
    if (!this.activeId) return null;
    return this.store.loadMeta(this.activeId);
  }

  /** Сделать сессию активной (нет такой — ошибка). */
  setActive(id: string): void {
    if (!this.store.sessionExists(id)) {
      throw new Error(t("session.not_found", { id }));
    }
    this.activeId = id;
  }

  /**
   * Сбросить активную сессию (вкладок не осталось). Сессия на диске жива —
   * следующий `create`/`setActive` вернёт её или создаст новую. Нужен, чтобы
   * закрытие последней вкладки не оставляло «висящий» активный контекст.
   */
  clearActive(): void {
    this.activeId = null;
  }

  /**
   * Сibling-менеджер поверх ТОГО ЖЕ стора, запиненный на сессию `id`.
   * Общий стор (и его метакеш) держит записи консистентными между форками:
   * `appendMessage` читает счётчик с диска, файлы сессий не пересекаются.
   * Нужен параллельным раннерам: каждый ход пишет в свою сессию, не трогая
   * чужой `activeId`. Никогда не зовёт create/setActive — только чтение/запись
   * своей сессии. Нет такой сессии — ошибка, как у setActive.
   */
  forkPinned(id: string): SessionManager {
    if (!this.store.sessionExists(id)) {
      throw new Error(t("session.not_found", { id }));
    }
    const sibling = new SessionManager(this.store, this.options);
    sibling.activeId = id;
    // Своя копия списка подписчиков: общий массив означал, что отписка
    // раннера снимала подписку ГЛАВНОГО менеджера (аудит §7.16). Переименование
    // сиблинга уведомляет и главного менеджера (см. `rename`).
    sibling.renameListeners = [];
    sibling.parentManager = this;
    return sibling;
  }

  /** Добавить сообщение в активную сессию (нет активной — ошибка). */
  appendMessage(msg: SessionMessage): void {
    if (!this.activeId) throw new Error(t("session.no_active"));
    this.store.appendMessage(this.activeId, msg);
  }

  /**
   * Запись в лог активной или явно указанной сессии (B-35: фоновая вкладка).
   * Без id и без активной — молча пропуск.
   */
  appendLog(entry: SessionLogEntry, id: string | null = this.activeId): void {
    if (id) this.store.appendSessionLog(id, entry);
  }

  /**
   * Прочитать session.jsonl сессии (для `session show`); с `since` — только хвост.
   */
  loadSessionLog(id: string, opts: { since?: string } = {}): SessionLogEntry[] {
    try {
      return this.store.loadSessionLog(id, opts);
    } catch {
      return [];
    }
  }

  /** История активной сессии ([] — нет активной). */
  loadHistory(): SessionMessage[] {
    if (!this.activeId) return [];
    return this.store.loadHistory(this.activeId);
  }

  /**
   * История любой сессии, включая ротированные (фолбэк на архив
   * `<id>.jsonl.gz`, если живого history-файла нет). Для
   * `session export` / `/export`.
   */
  getHistory(id: string): SessionMessage[] {
    const live = this.store.loadHistory(id);
    if (live.length > 0) return live;
    return this.store.loadRotatedHistory(id);
  }

  /** Контекст активной сессии (для изоляции). */
  getSessionContext(): SessionContext | undefined {
    if (!this.activeId) return undefined;
    return this.getSessionContextById(this.activeId);
  }

  /** Каталог указанной сессии. */
  getSessionDirectory(id: string): string {
    return this.store.getSessionDir(id);
  }

  /** Контекст сессии по id (лениво создаётся из меты). */
  getSessionContextById(sessionId: string): SessionContext | undefined {
    if (!this.sessionContexts.has(sessionId)) {
      const meta = this.store.loadMeta(sessionId);
      if (!meta) return undefined;

      const context = createSessionContext(
        sessionId,
        meta.projectDir,
        this.options.isolation,
        normalizeSecurityOverrides(meta.securityOverrides),
      );
      this.sessionContexts.set(sessionId, context);
    }
    return this.sessionContexts.get(sessionId);
  }

  /** Конфиг изоляции сессий. */
  getIsolationConfig(): SessionIsolationConfig {
    return this.options.isolation ?? DEFAULT_SESSION_ISOLATION;
  }

  /** Включена ли изоляция сессий. */
  isIsolationEnabled(): boolean {
    return this.getIsolationConfig().enabled;
  }

  /**
   * Отметить сессию занятой (живой раннер) — такие сессии не вычищаются
   * лимитом числа сессий (аудит §7.15).
   */
  markBusy(id: string, busy: boolean): void {
    if (busy) this.busySessions.add(id);
    else this.busySessions.delete(id);
  }

  /** Есть ли у сессии живой раннер. */
  isBusy(id: string): boolean {
    return this.busySessions.has(id);
  }

  /** Планирует автоочистку в фоне (A-01). */
  private scheduleEnforceMaxSessions(): void {
    const warn = (message: string) => this.options.logger?.warn(message);
    scheduleAutoPrune(this.pruneState, () => this.enforceMaxSessions(), warn);
  }

  private enforceMaxSessions(): void {
    autoPruneSessions({
      max: this.options.maxSessions ?? 50,
      count: () => this.store.countSessions(),
      list: () => this.store.listSessions(),
      remove: (id) => this.delete(id),
      isBusy: (id) => this.busySessions.has(id),
      warn: (message) => this.options.logger?.warn(message),
    });
  }
}
