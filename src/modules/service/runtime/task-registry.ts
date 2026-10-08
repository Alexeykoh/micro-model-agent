/**
 * Реестр задач процесса: task = ход над сессией (спека §5.2).
 *
 * Состояние задачи выводится из `SessionManager`/журнала + этого in-memory
 * реестра; отдельной «таблицы заданий» рядом с сессиями не вводится. Реестр
 * держит: жизненный цикл, синхронных ожидающих (`wait:true`), события задачи,
 * идемпотентность сабмита и retention терминальных результатов.
 */
import type { ProblemDetails } from "./problem";
import type { Envelope } from "./envelope";
import { newJobId } from "./ids";

/**
 * Tenant-контекст «едет с работой» (спека §10.2): резолвится из auth-заголовков
 * control plane'а, никогда — из тела запроса/prompt. Пишется в журнал сессии.
 */
export interface TenantContext {
  tenantId?: string;
  principalId?: string;
  runId?: string;
  tier?: string;
  scopes?: string[];
}

/** Режим задачи: интерактивная (вопросы разрешены) или автономная (job). */
export type TaskMode = "interactive" | "job";

/** Жизненный цикл задачи (спека §5.3). */
export type TaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timeout"
  | "waiting_input";

/** Учёт расхода токенов/стоимости по задаче. */
export interface TaskUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Контракт структурированного вывода (спека §8.2). */
export interface TaskOutputSpec {
  format: "text" | "json";
  schema?: unknown;
}

/** Внутренняя запись задачи; сериализуется в Job-объект отдельным маппером. */
export interface TaskRecord {
  jobId: string;
  sessionId: string;
  mode: TaskMode;
  status: TaskStatus;
  input: string;
  output?: TaskOutputSpec;
  toolAllowlist?: string[];
  timeoutMs?: number;
  callbackUrl?: string;
  externalRef?: string;
  /** Tenant/run-контекст из auth control plane'а (для журнала/аудита). */
  tenant?: TenantContext;
  progress?: { percent: number; message?: string };
  result?: { text: string; data?: unknown };
  usage?: TaskUsage;
  error?: ProblemDetails;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** События задачи (для resume/наблюдаемости внутри процесса). */
  events: Envelope[];
  /** Резолверы синхронного ожидания завершения (`wait:true`). */
  waiters: Array<() => void>;
}

/** Параметры создания задачи. */
export interface TaskCreateParams {
  sessionId: string;
  mode: TaskMode;
  input: string;
  output?: TaskOutputSpec;
  toolAllowlist?: string[];
  timeoutMs?: number;
  callbackUrl?: string;
  externalRef?: string;
  tenant?: TenantContext;
}

/** Итог проверки Idempotency-Key. */
export type IdempotencyResult =
  | { kind: "miss" }
  | { kind: "hit"; jobId: string }
  | { kind: "conflict" };

/** Терминальный ли статус (дальше переходов нет). */
export function isTerminal(status: TaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout"
  );
}

/** In-memory реестр задач; без IO (персистентность/строка — control plane). */
export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>();
  private idem = new Map<string, { bodyHash: string; jobId: string; expiresAt: number }>();
  private readonly now: () => number;

  constructor(
    private readonly opts: { retentionDays: number; idempotencyTtlHours: number; now?: () => number },
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Создаёт задачу в статусе `queued`. */
  create(params: TaskCreateParams): TaskRecord {
    const rec: TaskRecord = {
      jobId: newJobId(),
      sessionId: params.sessionId,
      mode: params.mode,
      status: "queued",
      input: params.input,
      ...(params.output ? { output: params.output } : {}),
      ...(params.toolAllowlist ? { toolAllowlist: params.toolAllowlist } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.callbackUrl ? { callbackUrl: params.callbackUrl } : {}),
      ...(params.externalRef ? { externalRef: params.externalRef } : {}),
      ...(params.tenant ? { tenant: params.tenant } : {}),
      createdAt: new Date(this.now()).toISOString(),
      events: [],
      waiters: [],
    };
    this.tasks.set(rec.jobId, rec);
    return rec;
  }

  get(jobId: string): TaskRecord | undefined {
    return this.tasks.get(jobId);
  }

  listForSession(sessionId: string): TaskRecord[] {
    return [...this.tasks.values()].filter((t) => t.sessionId === sessionId);
  }

  /** Патч полей записи (статус/usage/progress/…). */
  update(jobId: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
    const rec = this.tasks.get(jobId);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    return rec;
  }

  /** Терминальный переход: проставляет `finishedAt` и будит ожидающих. */
  finish(jobId: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
    const rec = this.tasks.get(jobId);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    if (!rec.finishedAt) rec.finishedAt = new Date(this.now()).toISOString();
    const waiters = rec.waiters.splice(0);
    for (const wake of waiters) wake();
    return rec;
  }

  /** Резолвится немедленно, если задача терминальна, иначе — по завершении. */
  whenFinished(jobId: string): Promise<TaskRecord | undefined> {
    const rec = this.tasks.get(jobId);
    if (!rec) return Promise.resolve(undefined);
    if (isTerminal(rec.status)) return Promise.resolve(rec);
    return new Promise((resolve) => {
      rec.waiters.push(() => resolve(this.tasks.get(jobId)));
    });
  }

  /** Проверка ключа идемпотентности: hit / conflict / miss (TTL учитывается). */
  checkIdempotency(principal: string, key: string, bodyHash: string): IdempotencyResult {
    const mapKey = `${principal}::${key}`;
    const entry = this.idem.get(mapKey);
    if (!entry) return { kind: "miss" };
    if (entry.expiresAt <= this.now()) {
      this.idem.delete(mapKey);
      return { kind: "miss" };
    }
    if (entry.bodyHash !== bodyHash) return { kind: "conflict" };
    return { kind: "hit", jobId: entry.jobId };
  }

  /** Запоминает ключ идемпотентности с TTL. */
  recordIdempotency(principal: string, key: string, bodyHash: string, jobId: string): void {
    this.idem.set(`${principal}::${key}`, {
      bodyHash,
      jobId,
      expiresAt: this.now() + this.opts.idempotencyTtlHours * 3_600_000,
    });
  }

  /** Чистит протухшие idempotency-ключи и старые терминальные результаты. */
  prune(): void {
    const now = this.now();
    const cutoff = now - this.opts.retentionDays * 86_400_000;
    for (const [id, rec] of this.tasks) {
      if (isTerminal(rec.status) && Date.parse(rec.finishedAt ?? rec.createdAt) < cutoff) {
        this.tasks.delete(id);
      }
    }
    for (const [key, entry] of this.idem) {
      if (entry.expiresAt <= now) this.idem.delete(key);
    }
  }
}
