/**
 * Общий стенд тестов сервиса: временная директория, депы с SessionManager,
 * stub-раннер и поиск первой сессии. Вынесено, чтобы файлы `tests/service/*`
 * не дублировали один и тот же setup (fallow duplication gate).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, SessionManager } from "../../src/modules/session";
import type { SessionRunner } from "../../src/core/bootstrap/session-runner";
import type { Agent } from "../../src/core/agent";
import type { AppConfig } from "../../src/config/types";
import { DEFAULTS } from "../../src/config/defaults";
import type { ServiceDeps } from "../../src/modules/service/state";
import { httpJson } from "./http-client";

/** Временная директория сервиса (изолированный config/workspace). */
export function tempServiceDir(): string {
  return mkdtempSync(join(tmpdir(), "mma-svc-"));
}

/** Удаляет временную директорию. */
export function cleanupServiceDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Stub-раннер на заданного агента (без реального bootstrap). */
export function stubRunner(sessionId: string, agent: unknown): SessionRunner {
  return {
    sessionId,
    agent,
    execModule: { getActivePlan: () => null },
    registry: { has: () => false, register: () => {} },
    toolCtx: { exitOnComplete: false },
    dispose() {},
  } as unknown as SessionRunner;
}

export interface ServiceDepsOptions {
  dir: string;
  /** Агент — тогда депы несут `spawnRunner`; без него (sessions API) раннер не нужен. */
  agent?: unknown;
  patch?: (c: AppConfig) => void;
  /** Тестовый шов: fetch для webhook-доставки. */
  webhookFetch?: typeof fetch;
  /** Тестовый шов: readiness-проба провайдера. */
  preflight?: () => Promise<{ ok: boolean; reason: string }>;
}

/** Депы сервиса: конфиг из DEFAULTS, SessionManager с одной тестовой сессией. */
export function makeServiceDeps(opts: ServiceDepsOptions): ServiceDeps {
  const config = structuredClone(DEFAULTS);
  config.service.host = "127.0.0.1";
  config.service.port = 0;
  config.service.token = undefined;
  opts.patch?.(config);
  const sessionManager = new SessionManager(new SessionStore(opts.dir), {
    model: config.model,
    contextWindow: config.contextWindow,
    projectDir: opts.dir,
  });
  sessionManager.create("svc-test");
  const deps: ServiceDeps = {
    agent: {} as unknown as Agent,
    config,
    sessionManager,
    baseDir: opts.dir,
  };
  if (opts.agent !== undefined) deps.spawnRunner = (id) => stubRunner(id, opts.agent);
  if (opts.webhookFetch) deps.webhookFetch = opts.webhookFetch;
  if (opts.preflight) deps.preflight = opts.preflight;
  return deps;
}

/** Id первой сессии из `GET /v1/sessions`. */
export async function firstSessionId(url: string): Promise<string> {
  const res = await httpJson(`${url}/v1/sessions`);
  return (res.json.sessions as Array<{ id: string }>)[0].id;
}
