/**
 * Состояние рантайма Agent Service API.
 *
 * Единица изоляции — процесс (silo, спека §10.1): один тенант = один процесс,
 * свой `MMA_CONFIG_DIR`/workspace. Состояние держит per-session пул прогонов
 * (`RunPool`), реестр задач, буфер envelope'ов и подключённых SSE-клиентов.
 */
import type { Server } from "node:http";
import type { Agent } from "../../core/api";
import type { SessionRunner } from "../../core/bootstrap/session-runner";
import type { AppConfig } from "../../config/types";
import { readEnv } from "../../config/env";
import type { SessionManager } from "../session/manager";
import type { ExecutionModule } from "../execution/module";
import { RunPool } from "../webui/session/session-pool";
import { TaskRegistry, type TenantContext } from "./runtime/task-registry";
import { EnvelopeLog } from "./runtime/envelope";

export type { TenantContext } from "./runtime/task-registry";

/** Входы старта сервиса (подмножество bootstrap-выходов; без UI-полей). */
export interface ServiceDeps {
  agent: Agent;
  config: AppConfig;
  sessionManager?: SessionManager;
  execModule?: ExecutionModule;
  configDir?: string;
  baseDir?: string;
  /** Фабрика per-session раннеров из bootstrap (параллелизм слотов). */
  spawnRunner?: (sessionId: string) => SessionRunner;
  /** Оверрайд бинда (иначе env `MMA_SERVICE_HOST`, затем `service.host`). */
  host?: string;
  /** Оверрайд порта (иначе env `MMA_SERVICE_PORT`, затем `service.port`). */
  port?: number;
  /** Оверрайд bearer-токена (иначе env `MMA_SERVICE_TOKEN`, затем `service.token`). */
  token?: string;
  /** Тестовый шов: fetch для webhook-доставки (дефолт — глобальный `fetch`). */
  webhookFetch?: typeof fetch;
  /** Тестовый шов: readiness-проба провайдера (дефолт — `preflightFromConfig`). */
  preflight?: () => Promise<{ ok: boolean; reason: string }>;
  /** Интервал SSE keep-alive `: ping` (мс); тестовый оверрайд. */
  keepaliveMs?: number;
  /** Кап конкурентных SSE-клиентов (дефолт 32); тестовый оверрайд. */
  maxSseClients?: number;
  /** Idle-таймаут SSE без событий (дефолт 120 000 мс); тестовый оверрайд. */
  sseIdleMs?: number;
}

/** Подключённый SSE-клиент одной сессии. */
export interface ServiceClient {
  sessionId: string;
  lastEventId: number;
  /** Когда клиенту последний раз уходили данные (событие или ping). */
  lastEventAt: number;
  send: (frame: string) => void;
}

/** Полное состояние рантайма сервиса. */
export interface AgentServiceState {
  deps: ServiceDeps;
  config: AppConfig;
  pool: RunPool;
  tasks: TaskRegistry;
  envelopes: EnvelopeLog;
  busy: boolean;
  agentRunning: boolean;
  turnSeq: number;
  clients: Set<ServiceClient>;
  pendingQuestions: Map<
    string,
    {
      resolve: (value: unknown) => void;
      sessionId?: string;
      taskId?: string;
      /** Таймер TTL висящего вопроса (unref); снимается при резолве. */
      timer?: ReturnType<typeof setTimeout>;
    }
  >;
  /** Периодический prune реестра задач (retention/idempotency TTL). */
  pruneTimer?: ReturnType<typeof setInterval>;
  /** Кэш readiness-пробы: живой LLM-запрос не на каждый `/v1/ready`. */
  readyCache?: { at: number; result: { ok: boolean; reason: string } };
  /** Rate-limit `/v1/ready` по адресу клиента (6/мин). */
  readyRate: Map<string, { count: number; resetAt: number }>;
  /** Кап конкурентных SSE-подписок (тестовый оверрайд — `deps.maxSseClients`). */
  maxSseClients: number;
  /** Idle-таймаут SSE без событий (мс). */
  sseIdleMs: number;
  server?: Server;
  starting?: Promise<string>;
  host: string;
  port: number;
  token?: string;
  /**
   * Тенант процесса (silo): авторитетный источник для authz. Заголовок
   * `X-Mma-Tenant` только сверяется с ним (см. `tenantOk` в server).
   */
  tenant: TenantContext;
  /** Интервал SSE keep-alive (мс). */
  keepaliveMs: number;
  startedAt: number;
}

/** Парсит целочисленный env; нечисловое/пустое → undefined (не маскируем под дефолт). */
function parseEnvInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * Тенант процесса: env `MMA_SERVICE_TENANT` перекрывает `service.tenant`.
 * Не задан — пустой контекст (один безымянный тенант на процесс).
 */
function processTenant(sg: AppConfig["service"]): TenantContext {
  const tenantId = readEnv("SERVICE_TENANT")?.trim() || sg.tenant;
  return tenantId ? { tenantId } : {};
}

/** Интервал фонового prune реестра задач. */
const PRUNE_INTERVAL_MS = 60_000;

/** Создаёт состояние сервиса и привязывает фабрику раннеров, если дана. */
export function createServiceState(deps: ServiceDeps): AgentServiceState {
  const sg = deps.config.service;
  const pool = new RunPool(undefined, sg.maxQueueLength);
  if (deps.spawnRunner) pool.setFactory(deps.spawnRunner);
  const state: AgentServiceState = {
    deps,
    config: deps.config,
    pool,
    tasks: new TaskRegistry({
      retentionDays: sg.resultRetentionDays,
      idempotencyTtlHours: sg.idempotencyTtlHours,
    }),
    envelopes: new EnvelopeLog(),
    busy: false,
    agentRunning: false,
    turnSeq: 0,
    clients: new Set(),
    pendingQuestions: new Map(),
    readyRate: new Map(),
    maxSseClients: deps.maxSseClients ?? 32,
    sseIdleMs: deps.sseIdleMs ?? 120_000,
    host: deps.host ?? readEnv("SERVICE_HOST") ?? sg.host,
    port: deps.port ?? parseEnvInt(readEnv("SERVICE_PORT")) ?? sg.port,
    token: deps.token ?? readEnv("SERVICE_TOKEN") ?? sg.token,
    tenant: processTenant(sg),
    keepaliveMs: deps.keepaliveMs ?? 20_000,
    startedAt: Date.now(),
  };
  const pruneTimer = setInterval(() => state.tasks.prune(), PRUNE_INTERVAL_MS);
  (pruneTimer as { unref?: () => void }).unref?.();
  state.pruneTimer = pruneTimer;
  return state;
}
