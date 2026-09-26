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

export interface SessionManagerOptions {
  model: string;
  contextWindow: number;
  projectDir: string;
  maxSessions?: number;
  /**
   * Session isolation configuration
   */
  isolation?: SessionIsolationConfig;
  /**
   * Session file encryption configuration
   */
  encryption?: SessionEncryptionConfig;
}

export class SessionManager {
  private store: SessionStore;
  private activeId: string | null = null;
  private options: SessionManagerOptions;
  /**
   * Map of session ID to session context (for isolation)
   */
  private sessionContexts: Map<string, SessionContext> = new Map();

  constructor(store: SessionStore, options: SessionManagerOptions) {
    this.store = store;
    this.options = options;

    // Initialize encryption if configured
    if (options.encryption) {
      this.store.updateEncryption(options.encryption);
    }
  }

  /**
   * Check if session file encryption is enabled
   */
  isEncryptionEnabled(): boolean {
    return this.store.isEncryptionEnabled();
  }

  /**
   * Update encryption configuration
   */
  updateEncryption(config: SessionEncryptionConfig): void {
    this.store.updateEncryption(config);
    this.options.encryption = config;
  }

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

    // Create session context
    const context = createSessionContext(
      id,
      this.options.projectDir,
      this.options.isolation,
      this.normalizeSecurityOverrides(securityOverrides),
    );
    this.sessionContexts.set(id, context);

    return meta;
  }

  list(): SessionMeta[] {
    return this.store.listSessions();
  }

  get(id: string): SessionMeta | null {
    return this.store.loadMeta(id);
  }

  delete(id: string): void {
    // Clean up session context
    const context = this.sessionContexts.get(id);
    if (context) {
      // In a real implementation, we would clean up temp files here
      this.sessionContexts.delete(id);
    }

    this.store.deleteSession(id);
    if (this.activeId === id) {
      this.activeId = null;
    }
  }

  rename(id: string, name: string, source: "auto" | "manual" = "manual"): void {
    const meta = this.store.loadMeta(id);
    if (!meta) throw new Error(t("session.not_found", { id }));
    meta.name = name;
    meta.nameSource = source;
    this.store.saveMeta(id, meta);
  }

  /** True when the session has no user message with non-empty text. Fail-open: read errors count as non-empty. */
  isEmptySession(id: string): boolean {
    const meta = this.store.loadMeta(id);
    if (!meta) return false;
    if ((meta.messageCount ?? 0) === 0) return true;
    let history;
    try {
      history = this.getHistory(id);
    } catch {
      return false;
    }
    return !history.some((m) => m.role === "user" && getMessageText(m.content).trim().length > 0);
  }

  /** Delete all empty sessions except `excludeId`. Returns deleted ids. Never throws. */
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
        // fail-open: skip unreadable sessions
      }
    }
    return deleted;
  }

  getActive(): string | null {
    return this.activeId;
  }

  getActiveMeta(): SessionMeta | null {
    if (!this.activeId) return null;
    return this.store.loadMeta(this.activeId);
  }

  setActive(id: string): void {
    if (!this.store.sessionExists(id)) {
      throw new Error(t("session.not_found", { id }));
    }
    this.activeId = id;
  }

  appendMessage(msg: SessionMessage): void {
    if (!this.activeId) throw new Error(t("session.no_active"));
    this.store.appendMessage(this.activeId, msg);
  }

  appendLog(entry: SessionLogEntry): void {
    if (!this.activeId) return;
    this.store.appendSessionLog(this.activeId, entry);
  }

  /** Read the full session.jsonl of any session (used by `session show`). */
  loadSessionLog(id: string): SessionLogEntry[] {
    try {
      return this.store.loadSessionLog(id);
    } catch {
      return [];
    }
  }

  loadHistory(): SessionMessage[] {
    if (!this.activeId) return [];
    return this.store.loadHistory(this.activeId);
  }

  /**
   * History of any session, including rotated ones (falls back to the
   * `<id>.jsonl.gz` archive when the live history file is gone). Used by
   * `session export` / `/export`.
   */
  getHistory(id: string): SessionMessage[] {
    const live = this.store.loadHistory(id);
    if (live.length > 0) return live;
    return this.store.loadRotatedHistory(id);
  }

  /**
   * Get the session context for the active session
   */
  getSessionContext(): SessionContext | undefined {
    if (!this.activeId) return undefined;
    return this.getSessionContextById(this.activeId);
  }

  /**
   * Get the session context for a specific session
   */
  getSessionDirectory(id: string): string {
    return this.store.getSessionDir(id);
  }

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

  /**
   * Get session isolation configuration
   */
  getIsolationConfig(): SessionIsolationConfig {
    return this.options.isolation ?? DEFAULT_SESSION_ISOLATION;
  }

  /**
   * Check if session isolation is enabled
   */
  isIsolationEnabled(): boolean {
    return this.getIsolationConfig().enabled;
  }

  /**
   * Normalize security overrides to match SecurityConfig structure
   */
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
