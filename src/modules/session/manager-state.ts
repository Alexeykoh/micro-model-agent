// Изменяемое состояние менеджера сессий: контексты изоляции, «занятые» сессии,
// автоочистка по лимиту. Вынесено из `manager.ts` (правило 6): здесь живёт
// состояние и его правила, а `SessionManager` остаётся фасадом над стором.
import type {
  SessionContext,
  SessionIsolationConfig,
} from "../../modules/security/session-isolation";
import {
  createSessionContext,
  DEFAULT_SESSION_ISOLATION,
} from "../../modules/security/session-isolation";
import type { SessionManagerOptions } from "./manager-options";
import type { SessionStore } from "./store";
import type { SessionMeta, SessionMessage } from "./types";
import { normalizeSecurityOverrides } from "./security-overrides";
import { autoPruneSessions, scheduleAutoPrune } from "./auto-prune";
import { isEmptySession, pruneEmptySessions, pruneOrphanSessionDirs, pruneSessionsByRetention } from "./prune";
import { t } from "../../i18n/index";

/** Подписчики переименования: свой список, у сиблинга — ещё и главный менеджер. */
export class RenameHub {
  private listeners: Array<(meta: SessionMeta) => void> = [];
  private parent?: RenameHub;

  /**
   * Сделать хаб сиблингом: свой список подписчиков, а уведомления — главному.
   * Общий массив означал бы, что отписка раннера снимает подписку главного
   * (аудит §7.16).
   */
  attachTo(parent: RenameHub): void {
    this.listeners = [];
    this.parent = parent;
  }

  /** Подписка; возвращает функцию отписки. */
  subscribe(cb: (meta: SessionMeta) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Уведомить своих подписчиков и подписчиков главного (ровно один уровень). */
  notify(meta: SessionMeta): void {
    this.deliver(meta);
    this.parent?.deliver(meta);
  }

  private deliver(meta: SessionMeta): void {
    for (const cb of this.listeners) {
      try {
        cb(meta);
      } catch {
        // fail-open: подписчик (UI-бродкаст) не должен ронять переименование
      }
    }
  }
}

/** Состояние одного менеджера: контексты по id, живые раннеры, флаг автоочистки. */
export class ManagerState {
  /** Контексты сессий (для изоляции) по id */
  private readonly contexts = new Map<string, SessionContext>();
  /** Сессии с живыми раннерами — их нельзя вычищать (аудит §7.15). */
  private readonly busy = new Set<string>();
  /** Один запланированный прогон автоочистки на менеджер. */
  private readonly prune = { scheduled: false };
  private readonly warn: (message: string) => void;

  constructor(
    private readonly store: SessionStore,
    private readonly options: SessionManagerOptions,
  ) {
    this.warn = (message) => options.logger?.warn(message);
  }

  /** Создать и запомнить контекст новой сессии. */
  registerContext(id: string, overrides: SessionMeta["securityOverrides"]): void {
    this.contexts.set(id, this.buildContext(id, this.options.projectDir, overrides));
  }

  /** Контекст сессии по id (лениво создаётся из меты). */
  context(sessionId: string): SessionContext | undefined {
    if (!this.contexts.has(sessionId)) {
      const meta = this.store.loadMeta(sessionId);
      if (!meta) return undefined;
      this.contexts.set(
        sessionId,
        this.buildContext(sessionId, meta.projectDir, meta.securityOverrides),
      );
    }
    return this.contexts.get(sessionId);
  }

  /** Забыть контекст удалённой сессии. */
  forgetContext(id: string): void {
    this.contexts.delete(id);
  }

  /** Конфиг изоляции сессий. */
  isolationConfig(): SessionIsolationConfig {
    return this.options.isolation ?? DEFAULT_SESSION_ISOLATION;
  }

  /** Отметить сессию занятой (живой раннер). */
  setBusy(id: string, busy: boolean): void {
    if (busy) this.busy.add(id);
    else this.busy.delete(id);
  }

  /** Есть ли у сессии живой раннер. */
  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  /** Пустая ли сессия. Fail-open: ошибки чтения — непустая. */
  isEmpty(id: string, history: (id: string) => SessionMessage[]): boolean {
    return isEmptySession(this.store, id, history);
  }

  /** Удалить все пустые сессии, кроме `excludeId`. Не бросает. */
  pruneEmpty(excludeId: string | undefined, remove: (id: string) => void): string[] {
    this.pruneOrphanDirs();
    return pruneEmptySessions(this.store, excludeId, remove);
  }

  /** Retention-prune: удалить сессии старше `retentionDays` (кроме `excludeId`). */
  pruneByRetention(
    retentionDays: number,
    excludeId: string | undefined,
    remove: (id: string) => void,
  ): string[] {
    return pruneSessionsByRetention(this.store, retentionDays, excludeId, remove);
  }

  /**
   * Чистка каталогов-сирот (INV-W4): след эагерного создания `temp`. Идёт в
   * фоне (`scheduleAutoPrune`) либо вместе с явной `session prune`, поэтому
   * старт и ответы HTTP не ждут удаления тысяч каталогов.
   */
  private pruneOrphanDirs(): void {
    try {
      const removed = pruneOrphanSessionDirs(this.store.baseDirPath());
      if (removed > 0) this.warn(t("session.orphans_pruned", { count: String(removed) }));
    } catch {
      // Fail-open: чистка сирот не должна срывать автоочистку сессий.
    }
  }

  /** Планирует автоочистку в фоне (A-01). */
  scheduleEnforceMaxSessions(remove: (id: string) => void): void {
    scheduleAutoPrune(this.prune, () => this.enforceMaxSessions(remove), this.warn);
  }

  private buildContext(
    id: string,
    projectDir: string,
    overrides: SessionMeta["securityOverrides"],
  ): SessionContext {
    return createSessionContext(
      id,
      projectDir,
      this.options.isolation,
      normalizeSecurityOverrides(overrides),
    );
  }

  private enforceMaxSessions(remove: (id: string) => void): void {
    this.pruneOrphanDirs();
    autoPruneSessions({
      max: this.options.maxSessions ?? 50,
      count: () => this.store.countSessions(),
      list: () => this.store.listSessions(),
      remove,
      isBusy: (id) => this.busy.has(id),
      warn: this.warn,
    });
  }
}
