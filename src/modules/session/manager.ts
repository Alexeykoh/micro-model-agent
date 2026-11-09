// Менеджер сессий: создание/удаление/переименование, активная, изоляция, лимиты.
import type { SessionMeta, SessionMessage } from "./types";
import type { SessionStore, SessionLogEntry } from "./store";
import type { TurnCheckpoint } from "./checkpoint";
import { t } from "../../i18n/index";
import type {
  SessionIsolationConfig,
  SessionContext,
} from "../../modules/security/session-isolation";
import type { SessionEncryptionConfig } from "../../config/types";
import { newSessionId, newThreadId } from "./id";
import type { SessionManagerOptions } from "./manager-options";
import { ManagerState, RenameHub } from "./manager-state";
import { applyEffectiveContext, touchActiveSession, getActiveMetaOf, activateSession, readSessionLog, readSessionLogWithStatus } from "./manager-lifecycle";

export type { SessionManagerOptions } from "./manager-options";

/** Менеджер: активная сессия, контексты изоляции, maxSessions, prune пустых. */
export class SessionManager {
  private store: SessionStore;
  private activeId: string | null = null;
  private options: SessionManagerOptions;
  /** Контексты изоляции, живые раннеры, автоочистка — отдельное состояние. */
  private state: ManagerState;
  /** Подписчики переименования (у pinned-сиблинга — свой хаб поверх главного). */
  private renames = new RenameHub();

  constructor(store: SessionStore, options: SessionManagerOptions) {
    this.store = store;
    this.options = options;
    this.state = new ManagerState(store, options);

    // Шифрование — если настроено
    if (options.encryption) {
      this.store.updateEncryption(options.encryption);
    }
  }

  /** Включено ли шифрование файлов сессий. */
  isEncryptionEnabled(): boolean {
    return this.store.isEncryptionEnabled();
  }

  /** Сохранить чекпоинт хода (durable state 2/4). */
  saveCheckpoint(id: string, checkpoint: TurnCheckpoint): void { this.store.saveCheckpoint(id, checkpoint); }

  /** Загрузить чекпоинт хода (нет/битый — null, fail-open). */
  loadCheckpoint(id: string): TurnCheckpoint | null { return this.store.loadCheckpoint(id); }

  /** Сохранить durable-interrupt паузы (`Agent.pause/resume`). */
  saveInterrupt(id: string, paused: boolean): void { this.state.saveInterrupt(id, paused); }

  /** Прочитать durable-interrupt паузы. */
  loadInterrupt(id: string): { paused: boolean } | null { return this.state.loadInterrupt(id); }

  /** Retention-prune: удалить сессии старше `retentionDays` (кроме активной). */
  pruneByRetention(retentionDays: number): string[] {
    return this.state.pruneByRetention(retentionDays, this.activeId ?? undefined, (sid) => this.delete(sid));
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
      threadId: newThreadId(),
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
    this.state.scheduleEnforceMaxSessions((sid) => this.delete(sid));
    // Авто-прунинг пустых сессий из create() убран: в web параллельные вкладки
    // держат пустые сессии, и создание новой затирало бы их (вкладки уходили в
    // dead). Чистка — явная команда `session prune` (CLI/REPL).
    this.state.registerContext(id, securityOverrides);

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
  getWithStatus(id: string): import("./read-status").SessionRead<SessionMeta> {
    return this.store.loadMetaWithStatus(id);
  }
  /** Удалить сессию (+ контекст, сброс активной). */
  delete(id: string): void {
    this.state.forgetContext(id);
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
    this.renames.notify(meta);
  }

  /** Подписка на переименование любой сессии (в т.ч. через pinned-сиблинг).
   *  Возвращает функцию отписки. */
  onRename(cb: (meta: SessionMeta) => void): () => void {
    return this.renames.subscribe(cb);
  }

  /**
   * Обновить окно/модель после probe/reconfigure. Пишет мету активной сессии И
   * дефолты новых (`create()` берёт их из `options`, а не из конфига). Fail-open.
   */
  setEffectiveContext(contextWindow: number, model?: string): void {
    applyEffectiveContext(this.store, this.options, this.activeId, contextWindow, model);
  }

  /**
   * Обновляет `updatedAt` активной сессии без изменения содержимого. Вызывается
   * в конце хода: `updatedAt` иначе двигает только `appendMessage`, поэтому ход
   * без сообщений (оборван на входе) оставлял мету со временем старта.
   * Fail-open: нет активной сессии — no-op.
   */
  touch(): void {
    touchActiveSession(this.store, this.activeId);
  }

  /** Пустая ли сессия (нет user-сообщения с текстом). Fail-open: ошибки чтения — непустая. */
  isEmptySession(id: string): boolean {
    return this.state.isEmpty(id, (sid) => this.getHistory(sid));
  }

  /** Удалить все пустые сессии, кроме `excludeId`. Вернуть удалённые id. Не бросает. */
  pruneEmpty(excludeId?: string): string[] {
    return this.state.pruneEmpty(excludeId, (id) => this.delete(id));
  }

  /** Id активной сессии (null — нет). */
  getActive(): string | null {
    return this.activeId;
  }

  /** Мета активной сессии (null — нет). */
  getActiveMeta(): SessionMeta | null {
    return getActiveMetaOf(this.store, this.activeId);
  }

  /** Сделать сессию активной (нет такой — ошибка). */
  setActive(id: string): void {
    activateSession(this.store, (next) => { this.activeId = next; }, id);
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
    sibling.renames.attachTo(this.renames);
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
    return readSessionLog(this.store, id, opts);
  }

  loadSessionLogWithStatus(
    id: string,
    opts: { since?: string } = {},
  ): import("./read-status").SessionRead<SessionLogEntry[]> {
    return readSessionLogWithStatus(this.store, id, opts);
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
    return this.state.context(this.activeId);
  }

  /** Каталог указанной сессии. */
  getSessionDirectory(id: string): string {
    return this.store.getSessionDir(id);
  }

  /** Контекст сессии по id (лениво создаётся из меты). */
  getSessionContextById(sessionId: string): SessionContext | undefined {
    return this.state.context(sessionId);
  }

  /** Конфиг изоляции сессий. */
  getIsolationConfig(): SessionIsolationConfig {
    return this.state.isolationConfig();
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
    this.state.setBusy(id, busy);
  }

  /** Есть ли у сессии живой раннер. */
  isBusy(id: string): boolean {
    return this.state.isBusy(id);
  }
}
