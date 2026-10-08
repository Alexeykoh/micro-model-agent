# Agent Service API v1 — Implementation Plan

> **For agentic workers:** execute task-by-task. Steps use checkbox (`- [ ]`) syntax. Design source: [docs/specs/2026-10-08-agent-service-api-design.md](../specs/2026-10-08-agent-service-api-design.md).

**Goal:** долгоживущий HTTP-сервис (`mma serve`), принимающий задачи от внешних систем по стабильному версионируемому контракту `Agent Service API v1` (HTTP + SSE), поверх существующих `bootstrap`/`RunPool`/`SessionRunner`/`Agent`, без правок ядра, REPL и `mma web`.

**Architecture:** новый модуль `src/modules/service/` — публичный API-слой, **отдельный** от `webui/server.ts`; внутренности (`RunPool`, `createSessionRunnerFactory`, `makeForwarder`, `PromptIO`-контракт, `SessionManager`) переиспользуются импортом. Единица изоляции — процесс (silo). Task = ход над сессией; состояние выводится из сессии/журнала + in-memory `TaskRegistry` (без отдельной «таблицы заданий»).

**Tech Stack:** Bun + TypeScript (ES2022/NodeNext), `node:http`, vitest (`bun test`), Biome, полный гейт `bun run quality` (typecheck + typecheck:frontend + lint + fallow).

---

## Архитектурные решения (фиксировано до кода)

1. **Повторное использование, не рефактор.** Импортируем `RunPool` (`src/modules/webui/session/session-pool.ts`), `createSessionRunnerFactory` (через `bootstrap().spawnSessionRunner`), `makeForwarder` (`src/modules/webui/session/forward.ts`), `SessionManager`, `bootstrap`, `applyAnswersToConfig`. `webui/*` не двигаем.
2. **SSE через адаптер над forwarder.** `makeForwarder(serviceState, sink)` где `sink` превращает `SseEvent` в envelope v1 и пишет в per-session event log + рассылку подписчикам. `serviceState` — минимальный объект с `pool`/`busy`/`agentRunning`/`turnSeq`.
3. **Runner turn — свой, не `makeRunAgent`.** `makeRunAgent` жёстко завязан на `WebUiState` (`pushState`, `recordTurnUsage`, live-usage таймер). Сервис пишет тонкий `runTask` (~90 строк), копирующий синтез tool-call id и вызовы `agent.run` — это дешевле, чем тянуть webui-состояние.
4. **PromptIO — свой web-совместимый.** `src/modules/service/runtime/prompt-io.ts` реализует `PromptIO` (`src/tools/prompt-io.ts`) поверх SSE `question` + `POST /v1/tasks/:jobId/answer`.
5. **Event resume — in-memory bounded log.** `seq` монотонный на сессию; `EnvelopeLog` (ring, cap 2000) в рантайме; `?since=`/`Last-Event-ID` → реплей из буфера. Если `since` старше буфера — `session.updated` + клиент re-pull `GET /v1/tasks/:jobId` (pull — источник правды, §8.3 спеки). Durability между рестартами процесса — best-effort в v1 (документируется).
6. **Idempotency-Key** — заголовок на `POST /v1/sessions/:id/tasks`; ключ `(principal,key)`; TTL `service.idempotencyTtlHours`.
7. **Тенант — из auth, не из тела.** Рантайм читает `X-Mma-Tenant`/`X-Mma-Principal`/`X-Mma-Run` из auth-заголовков и пишет в лог; тело запроса их не задаёт.

## File Structure

```
src/modules/service/
  module.ts             startAgentService(deps) → ServiceHandle { state, host, url, stop }
  state.ts              AgentServiceState, ServiceDeps, role slices, createServiceState()
  server.ts             http.createServer, request dispatch, auth, static-less
  http/
    routes.ts           API_ROUTES + API_GROUPS dispatch
    respond.ts          sendJson/sendProblem/readJson/auth helpers (reuse webui/util where clean)
  runtime/
    task-registry.ts    TaskRecord, TaskRegistry (create/get/list/update, idempotency)
    envelope.ts         Envelope type + seq allocator + EnvelopeLog
    event-bridge.ts     forwarder adapter (SseEvent → Envelope → log/broadcast)
    run-task.ts         runTask(): one turn over a SessionRunner, maps Agent callbacks
    prompt-io.ts        servicePromptIO(): question/approve over SSE + answer endpoint
    output.ts           structured-output instruction, parse, validate, retry-once
    webhook.ts          HMAC-SHA256 sign + deliver with backoff
    problem.ts          ProblemDetails type, stable type URIs, helpers
    ids.ts              jobId/eventId seq generators
  api/
    health.ts           GET /v1/health, GET /v1/ready
    sessions-api.ts     /v1/sessions CRUD (+ externalRef index)
    tasks-api.ts        submit/status/cancel/answer
    events-api.ts       GET /v1/sessions/:id/events (SSE)
  types.ts              public API types (TaskMode, JobStatus, JobObject, …)
src/cli/service-command.ts   mma serve → runServe()
tests/service/*.test.ts      per-module unit tests
```

Config/CLI touch-points (existing files):
- `src/config/types.ts` — `ServiceConfig` + `AppConfig.service`
- `src/config/defaults.ts` — `DEFAULTS.service`
- `src/config/domains.ts` — `service: ["service"]`
- `src/config/registry-extra.ts` — `service.*` `ConfigKeyDef`s
- `src/config/env.ts` — `SERVICE_PORT`/`SERVICE_HOST`/`SERVICE_TOKEN`
- `src/cli/commands.ts` — `buildServeCommand`, add `"serve"` to `longRunningCommands`
- `src/cli/main.ts` — serve dispatch branch (mirror `web`)
- `src/modules/session/types.ts` — `SessionMeta.externalRef?`
- `src/i18n/en.json` / `ru.json` — `cli.serve*`, `config.key.service.*`, `service.*`
- `src/index.ts` — export public service types (optional, §16 out of scope for SDK)

---

## Phase 1 — Foundation: config, CLI, skeleton server (health/ready)

**Deliverable:** `mma serve` поднимает HTTP-сервер на `service.port`/`service.host`, отдаёт `GET /v1/health` (200) и `GET /v1/ready` (200/503), требует `Authorization: Bearer <token>` если задан, корректно гасится по SIGINT/SIGTERM. `bun test` + `tsc --noEmit` зелёные.

### Task 1.1: `ServiceConfig` type + defaults + domain

**Files:** Modify `src/config/types.ts`, `src/config/defaults.ts`, `src/config/domains.ts`; Test `tests/config-registry-extra.test.ts` (extend existing) or new `tests/service/config.test.ts`.

- [ ] **Step 1 (type):** add before `AppConfig`:

```ts
export interface ServiceConfig {
  port: number;
  host: string;
  token?: string;
  resultRetentionDays: number;
  idempotencyTtlHours: number;
  syncWaitMs: number;
  maxQueueLength: number;
  callbackTimeoutMs: number;
}
```

add `service: ServiceConfig;` inside `AppConfig` (after `critic`).

- [ ] **Step 2 (defaults):** in `DEFAULTS`:

```ts
service: {
  port: 7331,
  host: "127.0.0.1",
  token: undefined,
  resultRetentionDays: 7,
  idempotencyTtlHours: 24,
  syncWaitMs: 10_000,
  maxQueueLength: 5,
  callbackTimeoutMs: 10_000,
},
```

- [ ] **Step 3 (domain):** `CONFIG_DOMAINS` add `service: ["service"],`.

- [ ] **Step 4:** run `bun test tests/config-domains.test.ts tests/config.test.ts` → PASS; `tsc --noEmit`.

### Task 1.2: env vars

**Files:** Modify `src/config/env.ts`.

- [ ] **Step 1:** add to `MMA_ENV`: `SERVICE_PORT: "MMA_SERVICE_PORT"`, `SERVICE_HOST: "MMA_SERVICE_HOST"`, `SERVICE_TOKEN: "MMA_SERVICE_TOKEN"`.

### Task 1.3: `service.*` config registry defs

**Files:** Modify `src/config/registry-extra.ts`; Test new `tests/service/config-registry.test.ts`.

- [ ] **Step 1 (failing test):**

```ts
// tests/service/config-registry.test.ts
import { describe, expect, it } from "vitest";
import { resolveConfigKey, setConfigValue } from "../../src/config/registry";
import { DEFAULTS } from "../../src/config/defaults";

describe("service config keys", () => {
  it("exposes port, host, token, retention, idempotency, syncWait, limits", () => {
    const keys = ["service.port","service.host","service.token","service.resultRetentionDays",
      "service.idempotencyTtlHours","service.syncWaitMs","service.maxQueueLength","service.callbackTimeoutMs"];
    for (const k of keys) expect(resolveConfigKey(k), k).toBeTruthy();
  });
  it("validates port range", () => {
    const cfg = structuredClone(DEFAULTS);
    expect(setConfigValue(cfg, "service.port", "70000").ok).toBe(false);
    expect(setConfigValue(cfg, "service.port", "7331").ok).toBe(true);
  });
});
```

- [ ] **Step 2:** Run `bun test tests/service/config-registry.test.ts` → FAIL.

- [ ] **Step 3:** add defs to `EXTRA_DEFS` (domain string `"service"`; `reconfigure:false` — рантайм читает на старте/живьём):

```ts
int("service.port", "service", 1, 65535, 1, false, (c) => c.service.port, (c, v) => { c.service.port = v as number; }),
str("service.host", "service", (c) => c.service.host, (c, v) => { c.service.host = String(v); }),
strOpt("service.token", "service", (c) => c.service.token ?? "", (c, v) => { const s = String(v ?? "").trim(); c.service.token = s === "" ? undefined : s; }),
int("service.resultRetentionDays", "service", 1, 365, 1, false, (c) => c.service.resultRetentionDays, (c, v) => { c.service.resultRetentionDays = v as number; }),
int("service.idempotencyTtlHours", "service", 1, 720, 1, false, (c) => c.service.idempotencyTtlHours, (c, v) => { c.service.idempotencyTtlHours = v as number; }),
int("service.syncWaitMs", "service", 0, 120_000, 1000, false, (c) => c.service.syncWaitMs, (c, v) => { c.service.syncWaitMs = v as number; }),
int("service.maxQueueLength", "service", 1, 100, 1, false, (c) => c.service.maxQueueLength, (c, v) => { c.service.maxQueueLength = v as number; }),
int("service.callbackTimeoutMs", "service", 1000, 120_000, 1000, false, (c) => c.service.callbackTimeoutMs, (c, v) => { c.service.callbackTimeoutMs = v as number; }),
```

- [ ] **Step 4:** Run test → PASS; `tsc --noEmit`.

### Task 1.4: i18n keys

**Files:** Modify `src/i18n/en.json`, `src/i18n/ru.json`.

- [ ] **Step 1:** add near `cli.web_*`:

```jsonc
// en.json
"cli.serve.description": "Run the agent as an HTTP service (Agent Service API v1)",
"cli.serve.port": "fixed port (default: service.port config, 7331)",
"cli.serve.host": "bind address (default: 127.0.0.1)",
"cli.serve.token": "require this bearer token (mandatory for non-loopback)",
"cli.serve_started": "agent service → http://{host}:{port}/v1 (directory: {dir})",
"cli.serve_invalid_port": "invalid --port \"{port}\": expected an integer between 1 and 65535",
"service.ready_ok": "ready",
"service.not_ready": "not ready: {reason}",
"service.missing_token_nonloopback": "refusing to bind {host} without a token; set service.token or --token",
```

```jsonc
// ru.json
"cli.serve.description": "Запустить агента как HTTP-сервис (Agent Service API v1)",
"cli.serve.port": "фиксированный порт (по умолчанию: service.port, 7331)",
"cli.serve.host": "адрес привязки (по умолчанию 127.0.0.1)",
"cli.serve.token": "требовать этот bearer-токен (обязателен для не-loopback)",
"cli.serve_started": "agent-сервис → http://{host}:{port}/v1 (директория: {dir})",
"cli.serve_invalid_port": "неверный --port «{port}»: нужно целое от 1 до 65535",
"service.ready_ok": "готов",
"service.not_ready": "не готов: {reason}",
"service.missing_token_nonloopback": "отказ привязки к {host} без токена; задайте service.token или --token",
```

- [ ] **Step 2:** `config.key.service.*` entries (both locales) — one per key above. Run `bun test tests/webui-i18n.test.ts` → PASS.

### Task 1.5: service state + problem types + health/ready routes

**Files:** Create `src/modules/service/types.ts`, `src/modules/service/runtime/problem.ts`, `src/modules/service/state.ts`, `src/modules/service/http/respond.ts`, `src/modules/service/api/health.ts`, `src/modules/service/http/routes.ts`; Test `tests/service/health.test.ts`.

- [ ] **Step 1 (problem.ts):**

```ts
export const PROBLEM_TYPES = {
  validation: "https://mma.dev/errors/validation",
  idempotencyConflict: "https://mma.dev/errors/idempotency-conflict",
  queueFull: "https://mma.dev/errors/queue-full",
  rateLimited: "https://mma.dev/errors/rate-limited",
  noSession: "https://mma.dev/errors/no-session",
  toolForbidden: "https://mma.dev/errors/tool-forbidden",
  outputInvalid: "https://mma.dev/errors/output-invalid",
  providerUnavailable: "https://mma.dev/errors/provider-unavailable",
  timeout: "https://mma.dev/errors/timeout",
  internal: "https://mma.dev/errors/internal",
} as const;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  is_retriable?: boolean;
  retry_after_ms?: number;
  trace_id?: string;
  suggestions?: string[];
}

export function problem(p: { type: keyof typeof PROBLEM_TYPES; title: string; status: number; detail?: string; instance?: string; retriable?: boolean; retryAfterMs?: number; traceId?: string; suggestions?: string[] }): ProblemDetails {
  return {
    type: PROBLEM_TYPES[p.type], title: p.title, status: p.status,
    ...(p.detail ? { detail: p.detail } : {}),
    ...(p.instance ? { instance: p.instance } : {}),
    is_retriable: p.retriable ?? false,
    retry_after_ms: p.retryAfterMs ?? 0,
    ...(p.traceId ? { trace_id: p.traceId } : {}),
    ...(p.suggestions ? { suggestions: p.suggestions } : {}),
  };
}
```

- [ ] **Step 2 (state.ts):** `ServiceDeps` mirrors `WebUiDeps` minus UI: `agent, config, sessionManager, execModule, memory?, skills?, plugins?, toolRegistry?, toolCtx?, configDir, baseDir, contextProbe?, knownModels?, spawnRunner?, host?, token?`. `AgentServiceState`:

```ts
export interface AgentServiceState {
  deps: ServiceDeps;
  config: AppConfig;
  pool: RunPool;
  tasks: TaskRegistry;
  busy: boolean;
  agentRunning: boolean;
  turnSeq: number;
  clients: Set<ServiceClient>;
  server?: Server;
  starting?: Promise<string>;
  host: string;
  port: number;
  token?: string;
  tenant?: TenantContext;
}
```

`createServiceState(deps)` constructs `pool = new RunPool()` and `tasks = new TaskRegistry(config.service)`; if `deps.spawnRunner` → `pool.setFactory(deps.spawnRunner)`.

- [ ] **Step 3 (respond.ts):** `sendJson(res,status,body)`, `sendProblem(res, pd)` (`Content-Type: application/problem+json`), `readJson(req, cap=32*1024*1024)`, `checkBearer(req, token)` (constant-time compare via `timingSafeEqual`; missing token ⇒ true), `isLoopback(host)` (copy semantics from `webui/util.ts` — import `isLoopback` directly instead of copying where possible).

- [ ] **Step 4 (health.ts):**

```ts
export function handleHealth(_req, res): void { sendJson(res, 200, { status: "ok", version: VERSION }); }
export async function handleReady(_req, res, s: AgentServiceState): Promise<void> {
  try {
    const ok = await checkProviderReady(s.deps); // probes active provider with a tiny request or listModels
    if (ok) sendJson(res, 200, { status: "ready" });
    else sendProblem(res, problem({ type: "providerUnavailable", title: "provider not ready", status: 503, retriable: true }));
  } catch { sendProblem(res, problem({ type: "providerUnavailable", title: "provider not ready", status: 503, retriable: true })); }
}
```

`checkProviderReady` = reuse `preflightFromConfig` from `src/modules/providers/preflight.ts` if signature allows, else `listModels` with a 3s timeout; fail-open to `true` if probe unsupported. (Read the module before coding.)

- [ ] **Step 5 (routes.ts):** exact `API_ROUTES` map mirroring `webui/server.ts`:

```ts
const API_ROUTES: Record<string, RouteHandler> = {
  "GET /v1/health": (req, res) => handleHealth(req, res),
  "GET /v1/ready": (req, res, s) => void handleReady(req, res, s),
};
export async function handleApi(req, res, reqUrl, s): Promise<void> {
  const route = API_ROUTES[`${req.method} ${reqUrl.pathname}`];
  if (route) { await route(req, res, s); return; }
  for (const g of API_GROUPS) { if (await g(req, res, reqUrl, s)) return; }
  sendProblem(res, problem({ type: "validation", title: "not found", status: 404 }));
}
```

- [ ] **Step 6 (health.test.ts):** start server on ephemeral port (`server.listen(0)`), fetch `/v1/health` → 200, `/v1/ready` → 200 or 503, unknown route → 404 problem+json, wrong bearer → 401. Use a hand-built `ServiceDeps` stub (no real bootstrap).

### Task 1.6: server + module

**Files:** Create `src/modules/service/server.ts`, `src/modules/service/module.ts`; Test `tests/service/server.test.ts`.

- [ ] **Step 1 (server.ts):** `createServer(state)`; `startServiceServer(state): Promise<string>` resolves URL; set `Cache-Control: no-cache, no-transform` on all; auth: if `state.token` and not `/v1/health`, require `Authorization: Bearer`. Reject non-loopback bind without token with `service.missing_token_nonloopback`. `stopServiceServer(state)` closes server + clears pool + `cancelPendingQuestions`.

- [ ] **Step 2 (module.ts):**

```ts
export interface ServiceHandle { state: AgentServiceState; url: Promise<string>; stop(): void; }
export async function startAgentService(deps: ServiceDeps): Promise<ServiceHandle> {
  const state = createServiceState(deps);
  const url = await startServiceServer(state);
  return { state, url, stop: () => stopServiceServer(state) };
}
```

- [ ] **Step 3:** `tsc --noEmit`; `bun test tests/service/` → PASS.

### Task 1.7: CLI `mma serve`

**Files:** Create `src/cli/service-command.ts`; Modify `src/cli/commands.ts`, `src/cli/main.ts`; Test `tests/service/serve-command.test.ts`.

- [ ] **Step 1 (service-command.ts):** mirror `web-command.ts`:

```ts
export interface ServeCommandOptions { port?: number; host?: string; token?: string; projectDir?: string; noAgentsMd?: boolean; }
export function parseServePort(raw: string | undefined): number | undefined  // same rule as parsePort, error key cli.serve_invalid_port
export async function runServe(opts: ServeCommandOptions): Promise<void> {
  const { agent, config, sessionManager, execModule, memoryStore, skillsModule, pluginManager, toolRegistry, toolCtx, configDir, baseDir, noAgentsMd, indexerModule, lspModule, contextProbe, spawnSessionRunner } = await bootstrap(undefined, opts.projectDir, opts.noAgentsMd, true);
  const port = opts.port ?? config.service.port;
  const host = opts.host ?? config.service.host;
  const token = opts.token ?? config.service.token;
  const svc = await startAgentService({ agent, config, sessionManager, execModule, memory: memoryStore, skills: skillsModule, plugins: pluginManager, toolRegistry, toolCtx, configDir, baseDir, indexer: indexerModule, lsp: lspModule, contextProbe, host, token, noAgentsMd, spawnRunner: spawnSessionRunner });
  const url = await svc.url;
  getDefaultChannel().writeLine(t("cli.serve_started", { host, port: String(port), dir: baseDir }));
  await waitForSignal(() => { svc.stop(); agent.shutdown(); });
}
```

- [ ] **Step 2 (commands.ts):** add `buildServeCommand(program)` (command `serve`, options `-p,--port`, `--host`, `--token`, no-op action) + call it; add `"serve"` to `longRunningCommands`.

- [ ] **Step 3 (main.ts):** add `valueOpts`? (no global value opts added). Add branch after the `web` branch:

```ts
if (program.args[0] === "serve") {
  const o = (program.commands.find((c) => c.name() === "serve")?.opts() ?? {}) as { port?: string; host?: string; token?: string };
  let port: number | undefined;
  try { port = parseServePort(o.port); }
  catch (err) { getDefaultChannel().writeLine(pc.red(`  ${errMsg(err)}`), "stderr"); process.exit(2); }
  await runServe({ port, host: o.host, token: o.token, projectDir, noAgentsMd });
  process.exit(0);
}
```

- [ ] **Step 4:** `bun test tests/service/serve-command.test.ts tests/cli-support.test.ts` (or closest existing) → PASS; `tsc --noEmit`.

**Phase 1 acceptance:** `bun run mma serve --port 0` prints `agent service → …`, `curl -H "Authorization: Bearer <t>" localhost:<p>/v1/health` → 200, Ctrl+C exits cleanly. `mma serve` without token on `0.0.0.0` refuses.

---

## Phase 2 — Session model: `externalRef` + Sessions API

**Deliverable:** `POST/GET/GET:id/DELETE /v1/sessions`, with optional `externalRef` (persisted + indexed in-process).

### Task 2.1: `SessionMeta.externalRef`

**Files:** Modify `src/modules/session/types.ts`; Test `tests/service/session-external-ref.test.ts`.

- [ ] **Step 1:** add to `SessionMeta`: `externalRef?: string;` (backward compatible; optional).
- [ ] **Step 2 (failing test):** create session with `externalRef`, `saveMeta`/`loadMeta` round-trip preserves it; old meta.json without field loads with `undefined`.
- [ ] **Step 3:** `SessionManager.create` needs an options path to pass `externalRef`. Extend `create(name?: string, securityOverrides?)` → `create(name?: string, securityOverrides?, externalRef?: string)` (append-only; update `SessionPhase`/web callers compile). Assert existing call sites still typecheck.

### Task 2.2: Sessions API

**Files:** Create `src/modules/service/api/sessions-api.ts`; wire into `http/routes.ts` `API_GROUPS`; Test `tests/service/sessions-api.test.ts`.

- [ ] **Step 1 (tests):** `POST /v1/sessions {externalRef,name}` → 201 `{id,externalRef,name,status,createdAt}`; `GET /v1/sessions?externalRef=` filters; `GET /v1/sessions/:id` 200/404 `no-session`; `DELETE` → 204 and `pool.drop(id)`/`execModule.forgetSession(id)`; delete unknown → 404.
- [ ] **Step 2 (impl):** handler group `(req,res,reqUrl,s)=>boolean`; status derived from `pool.isBusy/queuedCounts`; `externalRef` index = scan `sessionManager.list()` (no new store; spec Q5 says control plane owns authoritative mapping).
- [ ] **Step 3:** `bun test tests/service/sessions-api.test.ts`; `tsc --noEmit`.

**Phase 2 acceptance:** session CRUD via curl; externalRef round-trips.

---

## Phase 3 — Task model + Jobs API

**Deliverable:** `POST /v1/sessions/:id/tasks` (job → 202+jobId), `GET /v1/tasks/:jobId`, `POST /v1/tasks/:jobId/cancel`, idempotency, timeout, RFC 9457 errors, `RunPool` single-flight.

### Task 3.1: `TaskRegistry` + ids

**Files:** Create `src/modules/service/runtime/ids.ts`, `src/modules/service/runtime/task-registry.ts`; Test `tests/service/task-registry.test.ts`.

- [ ] **Step 1 (ids.ts):** `newJobId()` = `job_${Date.now().toString(36)}_${rand(6)}`; `newEventId()`.
- [ ] **Step 2 (task-registry.ts):** `TaskRecord` (spec §6.3 + internal `input`, `toolAllowlist`, `events: Envelope[]`, `waiters`, `bodyHash`), `TaskRegistry`:
  - `create(params): TaskRecord`; `get(id)`; `listForSession(id)`; `update(id, patch)`; `finish(id, patch)` (sets `finishedAt`, notifies waiters, returns record).
  - idempotency: `rememberIdempotency(principal, key, bodyHash, record)`; `lookupIdempotency(principal, key)` → `{record} | "conflict" | null`; TTL prune on access.
  - retention: `prune()` drops terminal records older than `resultRetentionDays`.
- [ ] **Step 3 (tests):** create/get/update/finish; waiter resolves on finish; idempotency returns same record for same bodyHash, `"conflict"` for different; TTL expiry.

### Task 3.2: structured `runTask` over SessionRunner

**Files:** Create `src/modules/service/runtime/run-task.ts`; Test `tests/service/run-task.test.ts` (uses `agentFactory`/stub runner, no live model).

- [ ] **Step 1:** `runTask(deps: { runner: SessionRunner; task: TaskRecord; serviceState; sink })`:
  - call `runner.agent.run(task.input, onText, onMeta, onTool, onPhase, onReasoning)`;
  - replicate webui `makeRunAgent` tool-id LIFO synthesis (startId/endId stack per tool name);
  - map each callback to `forwarder.on*`; `onTool` start→`onToolStart`, end→`onToolEnd`;
  - on success: `forwarder.onTurnEnd({success:true,...})`; capture `AgentResult.usage` into `task.usage`;
  - on `AbortError`/shutdown → cancelled; on throw → failed with `problem(internal)`.
- [ ] **Step 2 (tests):** stub `Agent.run` driving callbacks → assert sink receives `tool.start`/`tool.end`/`text.delta` and terminal. No live model.

### Task 3.3: Tasks API — submit/status/cancel

**Files:** Create `src/modules/service/api/tasks-api.ts`; wire routes; Test `tests/service/tasks-api.test.ts` (hand-built state + stub runner factory + stub agent).

- [ ] **Step 1 (submit tests):**
  - job mode → `202` + `Location: /v1/tasks/<id>` + `Retry-After: 5` + body `{jobId,status:"queued",statusUrl}`.
  - `wait:true` finished within `syncWaitMs` → `200` with Job object.
  - `wait:true` not finished → `202`.
  - missing session → 404 `no-session` problem.
  - queue full (pool at `service.maxQueueLength`) → 429 `queue-full` problem.
  - `Idempotency-Key` repeat same body → same jobId, no second run; different body → 409 `idempotency-conflict`.
- [ ] **Step 2 (submit impl):** resolve session via `sessionManager.get`; map mode; if `job` → `pool.isBusy` ? `enqueue` : reserve + `startTurn`; create `TaskRecord` status `queued`; return 202. `wait:true` → `Promise.race([finishPromise, timeout(syncWaitMs)])`.
  - `dispatch` modeled on `webui/session/turns.ts`: `reserveBusy`-equivalent against `pool` (need a small local `reserve`/`release` since `reserveBusy` is webui-specific — call `pool.reserve/release` + set `state.busy`).
- [ ] **Step 3 (status):** `GET /v1/tasks/:jobId` returns Job object (§6.3), same shape as webhook would POST; 404 `no-session`? → use `validation`/`no-session`. Spec uses `no-session` 404 for sessions; for unknown task use `validation` 404 or add `unknown-task` to `PROBLEM_TYPES` (prefer reuse `no-session`? No — add `no-task`). **Decision:** add `noTask: "https://mma.dev/errors/no-task"` to `PROBLEM_TYPES`.
- [ ] **Step 4 (cancel):** `POST /v1/tasks/:jobId/cancel` → if queued: drop from queue + finish `cancelled`; if running: `runner.agent.shutdown(sessionId)` → `onTurnEnd`/catch maps to cancelled; → 202 `{jobId,status:"cancelled"|"running"}`.
- [ ] **Step 5 (timeout):** `setTimeout(task.timeoutMs)` → `shutdown` + finish `failed` with `problem(timeout)`. Clear timer on settle.
- [ ] **Step 6:** tests; `tsc --noEmit`.

### Task 3.4: model event bridge (forwarder adapter)

**Files:** Create `src/modules/service/runtime/envelope.ts`, `src/modules/service/runtime/event-bridge.ts`; Test `tests/service/event-bridge.test.ts`.

- [ ] **Step 1 (envelope.ts):** `Envelope {v:1,seq,ts,type,sessionId,taskId?,data}`; per-session seq allocator; `EnvelopeLog` ring (cap 2000) with `append(sessionId,env)`, `since(sessionId, seq)`.
- [ ] **Step 2 (event-bridge.ts):** `makeServiceForwarder(state, task)`:
  - builds `makeForwarder(bridgeState, sink)` where `bridgeState = { pool: state.pool, busy: state.busy, agentRunning: state.agentRunning, turnSeq: state.turnSeq }` (enough for `syncBusy`/`forceRelease`);
  - `sink(ev: SseEvent)` → map webui event type → envelope type: `text`→`text.delta`, `reasoning`→`reasoning.delta`, `meta`(status)→`phase`? (keep `meta` as `text.delta`? No: map status meta to no envelope; `tool` display meta dropped), `phase`→`phase`, `tool_start`→`tool.start`, `tool_end`→`tool.end`, `plan`→`plan`, `turn_end`→ terminal handling (emit `task.finished`/`task.failed`);
  - allocate seq, append to log, broadcast to matching clients.
- [ ] **Step 3 (tests):** feed synthetic `SseEvent`s → assert exact envelope type/seq/data mapping.

### Task 3.5: service PromptIO (job-forbidden handling + interactive scaffolding)

**Files:** Create `src/modules/service/runtime/prompt-io.ts`; Test `tests/service/prompt-io.test.ts`.

- [ ] **Step 1:** `servicePromptIO(state, sessionId)` implementing `PromptIO` (`src/tools/prompt-io.ts`) → emits `question` envelope, stores resolver in `state.pendingQuestions` keyed by id; `resolveAnswer(state,id,value)`.
- [ ] **Step 2:** job mode: register no prompt tools + set `toolCtx.exitOnComplete = true`; if model still calls `question`, executor returns `tool_forbidden` → task `failed` with `problem(toolForbidden)`. (Wiring in turn setup; assert in integration.)
- [ ] **Step 3:** tests for resolve + cancel.

**Phase 3 acceptance:** submit→202→pull→(with stub runner) succeeded; cancel; timeout; idempotency; unknown session 404.

---

## Phase 4 — SSE event stream

**Deliverable:** `GET /v1/sessions/:id/events`, keep-alive, `Last-Event-ID`/`?since=`, abort propagation.

### Task 4.1: events-api

**Files:** Create `src/modules/service/api/events-api.ts`; wire route group.

- [ ] **Step 1:** headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`, `Content-Encoding: identity`.
- [ ] **Step 2:** on connect: replay `log.since(sessionId, lastEventId ?? since ?? 0)` then subscribe; heartbeat `: ping\n\n` every 20s (`setInterval`).
- [ ] **Step 3:** frame format `id: <seq>\nevent: <type>\ndata: <json>\n\n`.
- [ ] **Step 4:** on `req.on("close")`: unsubscribe, clear timer, and if task running → `agent.shutdown(sessionId)` (abort propagation).
- [ ] **Step 5 (tests):** raw http client: connect, receive replayed frames, heartbeat, disconnect triggers shutdown (spy).

### Task 4.2: route wiring + `sessions/:id/events` param matching

- [ ] Add `handleEventsApi` to `API_GROUPS`; parse `:id`; 404 `no-session`.

**Phase 4 acceptance:** curl -N receives `event:` frames; reconnect with `Last-Event-ID` replays.

---

## Phase 5 — Interactive mode (question/answer, waiting_input)

**Deliverable:** `mode:"interactive"` registers prompt tools; question → `task.waiting_input` + `question` envelope; `POST /v1/tasks/:jobId/answer` resolves; terminal → succeeded.

### Task 5.1

**Files:** Modify `runtime/run-task.ts` (install promptIO per mode), `api/tasks-api.ts` (answer endpoint), `runtime/prompt-io.ts`.

- [ ] **Step 1 (tests):** stub agent calls `ctx.promptIO.askText(...)`; assert `waiting_input` + `question` envelope; POST answer → resolver called; task continues to `succeeded`.
- [ ] **Step 2:** status transitions `running → waiting_input → running → succeeded`; emit `task.waiting_input` then `task.started` again (or `task.resumed`? spec doesn't list resumed — reuse `task.started`).
- [ ] **Step 3:** `POST /v1/tasks/:jobId/answer {answer}` → 202; unknown/irrelevant → 409/404.

**Phase 5 acceptance:** interactive round-trip.

---

## Phase 6 — Structured output (`output.schema`)

**Deliverable:** `output:{format:"json",schema}` → instruction injected, response parsed (`jsonrepair`), validated in-runtime, one retry, else `failed` `output-invalid`.

### Task 6.1

**Files:** Create `src/modules/service/runtime/output.ts`; Test `tests/service/output.test.ts`.

- [ ] **Step 1 (tests):** valid JSON matching schema → `{text, data}`; fenced ```json block parsed; broken JSON repaired; schema mismatch first attempt → retry once with error text appended to input; second mismatch → `problem(outputInvalid)` with `field ... missing`.
- [ ] **Step 2 (impl):** `buildOutputInstruction(output)` appends a system-summary/user message describing required JSON + the schema; `extractJson(text)` (fenced/raw, `jsonrepair`); `validateAgainstSchema(data, schema)` — implement a **minimal subset** validator (type, required, enum, additionalProperties:false, array items type) without new deps.
- [ ] **Step 3:** wire into `runTask` (before `agent.run`, inject instruction; after success, validate; retry once).

**Phase 6 acceptance:** schema round-trip.

---

## Phase 7 — Webhook push (HMAC)

**Deliverable:** `callbackUrl` → on terminal, `POST` Job object signed HMAC-SHA256, retries with backoff+jitter, headers `X-Mma-Timestamp`/`X-Mma-Event-Id`/`X-Mma-Signature`.

### Task 7.1

**Files:** Create `src/modules/service/runtime/webhook.ts`; Test `tests/service/webhook.test.ts`.

- [ ] **Step 1:** `signature(secret, timestamp, body)` = `hmacSha256(secret, `${timestamp}.${body}`)` hex; `deliverWebhook({url, secret, job, eventId, timeoutMs, maxAttempts})` with `fetch`, backoff `base*2^n + jitter`, no retry on 2xx/4xx (except 429), retry on 5xx/network; `X-Mma-Event-Id` stable across retries.
- [ ] **Step 2 (tests):** verify signature with known vector; retry on 503 then 200; no retry on 400; timeout aborts.
- [ ] **Step 3:** call from `TaskRegistry.finish` (or `runTask` settle) when `callbackUrl` set; secret from config? **Decision:** `service.webhookSecret?` config key (add) or derive per-tenant; add `service.webhookSecret` optional string in Phase 1 config (include now to avoid churn).

**Phase 7 acceptance:** webhook receives signed Job object.

---

## Phase 8 — Docs, CHANGELOG, quality gate

- [ ] **Step 1:** update `AGENTS.md` — new module `src/modules/service/`, config domain `service.*`, `mma serve`, section «Agent Service API (v1)» with a summary of endpoints/envelope/config.
- [ ] **Step 2:** update `docs/agents/architecture.md` (module list) and add `docs/agents/service-api.md` (API reference: endpoints, error table, envelope, webhook, env). Reference from AGENTS.md Documentation table.
- [ ] **Step 3:** `CHANGELOG.md` → new MINOR `## [X.Y.Z] - 2026-10-08` Added: `mma serve`, Agent Service API v1, `service.*` config.
- [ ] **Step 4:** bump version in `package.json` (MINOR).
- [ ] **Step 5:** `bun run quality` (typecheck + typecheck:frontend + lint + fallow) exit 0; `bun test`.

---

## Сквозное

- Каждая фаза — самодостаточный, тестируемый инкремент; коммит на фазу (`feat(service): …`).
- Тестовые швы — как в проекте (stub `spawnRunner`/`agentFactory`, рукописный `ServiceDeps`), **без глобального `vi.mock`** (Bun-моки процесс-глобальны).
- Новые ключи конфига → `config.key.*` (en+ru) обязательно (parity-тест).
- `webui/*` не рефакторим; импортируем `RunPool`, `makeForwarder`, `isLoopback`, `readJsonBody`/`parseJsonBody` (из `webui/http/body.ts`), `MAX_BODY_BYTES` — где чисто; иначе — тонкие локальные копии.
- Envelope additive-only; `/v1` префикс.

## Self-review (покрытие спеки)

| Спека | Фазы |
|---|---|
| §5 сессии/externalRef | 2 |
| §5.2/5.3 task-модель/lifecycle | 3 |
| §6.1 endpoints | 1 (health/ready), 2 (sessions), 3 (tasks), 4 (events) |
| §6.2/6.3 submit + Job-ресурс | 3 |
| §7 SSE envelope/ops | 4 |
| §8 output-контракт | 6 |
| §8.3 push/HMAC | 7 |
| §8.4 wait | 3 |
| §9 idempotency/cancel/errors | 3 |
| §10 изоляция (silo) | 1 (процесс/конфиг), 3 (allowlist) |
| §11 auth | 1 |
| §12 deploy/lifecycle (`mma serve`, health/ready, graceful) | 1 |
| §13 аддитивность | все (только новые файлы + опц. `SessionMeta.externalRef`, `service.*`) |
| §14 версионирование | 4 (`v:1`, `/v1`), 8 |
| §15 тесты | все |
| §16 Q1–Q5 | 6 (Q1), 2 (Q5), 3 (Q3/Q4), config (Q2) |
| §18 out of scope | не реализуем |
