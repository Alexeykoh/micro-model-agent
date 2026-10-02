// Менеджер сессий: создание/удаление/переименование, активная, изоляция, лимиты.
import type { SessionMeta, SessionMessage } from "./types";
import type { SessionStore, SessionLogEntry } from "./store";
import { t } from "../../i18n/index";
import { getMessageText } from "../../llm/provider";
import type {
  SessionIsolationConfig,
  SessionContext,
} from "../../modules/security/session-isolation";
import {
  createSessionContext,
  DEFAULT_SESSION_ISOLATION,
} from "../../modules/security/session-isolation";
import type { SecurityConfig, SessionEncryptionConfig } from "../../config/types";

/** Опции менеджера сессий. */
export interface SessionManagerOptions {
  model: string;
  contextWindow: number;
  projectDir: string;
  maxSessions?: number;
  /** Конфиг изоляции сессий */
  isolation?: SessionIsolationConfig;
  /** Конфиг шифрования файлов сессий */
  encryption?: SessionEncryptionConfig;
}

/** Менеджер: активная сессия, контексты изоляции, maxSessions, prune пустых. */
export class SessionManager {
  private store: SessionStore;
  private activeId: string | null = null;
  private options: SessionManagerOptions;
  /** Контексты сессий (для изоляции) по id */
  private sessionContexts: Map<string, SessionContext> = new Map();

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

  /** Создать сессию (имя/оверрайды опциональны), сделать активной. */
  create(name?: string, securityOverrides?: SessionMeta["securityOverrides"]): SessionMeta {
    const now = new Date().toISOString();
    const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sessionName = name || t("session.default_name", { date: now.slice(0, 10) });
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
    };
    this.store.saveMeta(id, meta);
    this.activeId = id;
    this.enforceMaxSessions();
    try {
      this.pruneEmpty(id);
    } catch {
      // fail-open: автопрунинг не должен ломать создание сессии
    }

    // Контекст сессии
    const context = createSessionContext(
      id,
      this.options.projectDir,
      this.options.isolation,
      this.normalizeSecurityOverrides(securityOverrides),
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
  }

  /** Пустая ли сессия (нет user-сообщения с текстом). Fail-open: ошибки чтения — непустая. */
  isEmptySession(id: string): boolean {
    const meta = this.store.loadMeta(id);
    if (!meta) return false;
    if ((meta.messageCount ?? 0) === 0) return true;
    let history: SessionMessage[];
    try {
      history = this.getHistory(id);
    } catch {
      return false;
    }
    return !history.some((m) => m.role === "user" && getMessageText(m.content).trim().length > 0);
  }

  /** Удалить все пустые сессии, кроме `excludeId`. Вернуть удалённые id. Не бросает. */
  pruneEmpty(excludeId?: string): string[] {
    const deleted: string[] = [];
    for (const s of this.store.listSessions()) {
      if (s.id === excludeId) continue;
      try {
        if (this.isEmptySession(s.id)) {
          this.delete(s.id);
          deleted.push(s.id);
        }
      } catch {
        // fail-open: нечитаемые пропускаем
      }
    }
    return deleted;
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
    return sibling;
  }

  /** Добавить сообщение в активную сессию (нет активной — ошибка). */
  appendMessage(msg: SessionMessage): void {
    if (!this.activeId) throw new Error(t("session.no_active"));
    this.store.appendMessage(this.activeId, msg);
  }

  /** Добавить запись в лог активной сессии (без активной — молча пропуск). */
  appendLog(entry: SessionLogEntry): void {
    if (!this.activeId) return;
    this.store.appendSessionLog(this.activeId, entry);
  }

  /** Прочитать полный session.jsonl любой сессии (для `session show`). */
  loadSessionLog(id: string): SessionLogEntry[] {
    try {
      return this.store.loadSessionLog(id);
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
        this.normalizeSecurityOverrides(meta.securityOverrides),
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

  /** Нормализовать оверрайды под структуру SecurityConfig. */
  private normalizeSecurityOverrides(
    overrides?: SessionMeta["securityOverrides"],
  ): Partial<SecurityConfig> | undefined {
    if (!overrides) return undefined;

    return {
      maxFileOperations: overrides.maxFileOperations,
      maxRecursionDepth: overrides.maxRecursionDepth,
      rateLimits: overrides.rateLimits
        ? {
            maxRequestsPerMinute: overrides.rateLimits.maxRequestsPerMinute ?? 60,
            maxParallelTasks: overrides.rateLimits.maxParallelTasks ?? 5,
          }
        : undefined,
    };
  }

  private enforceMaxSessions(): void {
    const max = this.options.maxSessions ?? 50;
    if (max <= 0) return;
    const sessions = this.store.listSessions();
    if (sessions.length > max) {
      const toDelete = sessions.slice(max);
      for (const s of toDelete) {
        this.delete(s.id);
      }
    }
  }
}
