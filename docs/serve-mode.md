# Service mode (`mma serve`) — integrator guide

`mma serve` runs MMA as a long-lived HTTP service: the same `bootstrap()` /
`Agent` / sessions / tools as the CLI, exposed over a stable, versioned contract
(**Agent Service API v1**) so that external systems (bots, backends, cron) can
delegate tasks to the agent.

- API reference (endpoints, envelope, errors, config): [agents/service-api.md](./agents/service-api.md)
- Design spec: [specs/2026-10-08-agent-service-api-design.md](./specs/2026-10-08-agent-service-api-design.md)
- Implementation plan: [plans/2026-10-08-agent-service-api.md](./plans/2026-10-08-agent-service-api.md)

## When to use it

Use `mma serve` when a program — not a human — talks to the agent: a chat
backend, a workflow engine, a scheduler. For a human at a terminal use the REPL;
for a human in a browser use [`mma web`](./agents/architecture.md).

## Discovering the contract

The service describes itself — no need to read the repo:

```bash
curl -s localhost:7331/v1/openapi.json   # OpenAPI 3.1 (Swagger UI / Redoc / Postman / client gen)
open http://localhost:7331/v1/docs      # the same contract, human-readable, offline-safe HTML
```

Both URLs are printed on startup. They are served without the bearer token (like
`/v1/health` and `/v1/ready`): they describe the public API and expose no tenant
data. Everything under sessions/tasks/events still requires the token when one is
configured.

## Quick start

```bash
mma serve                                   # 127.0.0.1:7331 (config service.port)
mma serve --port 8080 --host 0.0.0.0 --token "$SECRET"
```

```bash
# create a session
curl -s -XPOST localhost:7331/v1/sessions \
  -H 'Authorization: Bearer '"$SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"externalRef":"chat:42","name":"support"}'
# → {"id":"ses_...","externalRef":"chat:42","status":"idle",...}

# submit a job and wait for it
curl -s -XPOST localhost:7331/v1/sessions/<id>/tasks \
  -H 'Authorization: Bearer '"$SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"input":"Summarize today\'s support backlog","mode":"job","wait":true}'
# → {"jobId":"job_...","status":"succeeded","result":{"text":"..."},"usage":{...}}
```

## Isolation & deployment (silo)

The core is process-centric (global memory, output singletons, one session
manager), so the unit of isolation is a **process**, not a tenant inside one
runtime:

- **1 tenant = 1 process** with its own `MMA_CONFIG_DIR` and workspace
  (`service.*`, sessions, memory, plugins, skills). Point each tenant at a
  separate directory; a control plane maps `tenant → process`.
- Run the runtime on **loopback or a private network** — never expose it to the
  internet. Terminate end-user auth in your control plane; the runtime only
  checks the internal `Authorization: Bearer` token.
- **Sizing:** a local single-engine backend (LM Studio / Ollama) has parallelism
  ≈ 1; hosted backends scale higher. In-process concurrency is the per-session
  single-flight `RunPool`; different sessions run in parallel.

## Configuration

`service.*` (in `~/.mma/config/service.json`; also via `/config` and web
Settings → Network → Agent Service API):

| Key | Default | Meaning |
|---|---|---|
| `service.port` | `7331` | listen port (`-p` overrides) |
| `service.host` | `127.0.0.1` | bind address; non-loopback requires a token |
| `service.token` | — | `Authorization: Bearer` secret |
| `service.resultRetentionDays` | `7` | how long terminal task results are kept |
| `service.idempotencyTtlHours` | `24` | `Idempotency-Key` lifetime |
| `service.syncWaitMs` | `10000` | upper bound for `wait:true` |
| `service.maxQueueLength` | `5` | per-session FIFO cap |
| `service.callbackTimeoutMs` | `10000` | webhook delivery timeout |
| `service.webhookSecret` | — | HMAC secret for webhook callbacks |

Env overrides (win over config): `MMA_SERVICE_PORT`, `MMA_SERVICE_HOST`,
`MMA_SERVICE_TOKEN`. Provisioning is headless — write the config files (or set
the env), no wizard needed.

## Sessions and tasks

- **Session** — a persistent conversation (`SessionManager`); optional
  `externalRef` is your own key (`chat_id`, `doc_id`, …). The authoritative
  tenant→session mapping lives in your control plane.
- **Task (job)** — a *turn* over a session, not a separate parallel entity. Two
  modes:
  - `job` — autonomous, questions forbidden; returns a structured result.
  - `interactive` — may ask questions over SSE (`POST /v1/tasks/:jobId/answer`).

Lifecycle: `queued → running → succeeded | failed | cancelled | timeout`
(`waiting_input` for interactive). Submit returns `202` + `Location` +
`Retry-After`; `wait:true` blocks up to `service.syncWaitMs` and returns the
terminal Job object if it fits. **Pull is the source of truth**
(`GET /v1/tasks/:jobId`); the SSE stream and webhooks are optimizations.

## Events (SSE)

```
GET /v1/sessions/:id/events
id: <seq>
event: <type>
data: { "v":1, "seq", "ts", "type", "sessionId", "taskId", "data" }
```

`seq` is monotonic per session; resume with `Last-Event-ID` or `?since=<seq>`.
Keep-alive comments (`: ping`) hold the connection under proxies; closing an
**interactive** stream cooperatively cancels its task (a `job` keeps running).

## Structured output

Let a job return validated JSON: `output: { format: "json", schema: { … } }`.
The runtime injects an instruction, parses the answer (`jsonrepair`), and
validates a strict JSON-Schema subset (`type`, `required`, `properties`,
`items`, `enum`, `additionalProperties: false`). One retry, then the task fails
with `error.type` = `…/output-invalid`.

## Webhooks

Pass `callbackUrl` on submit: on the terminal event the runtime `POST`s the same
Job object with `X-Mma-Timestamp` and `X-Mma-Event-Id` (stable across retries)
headers. **The `X-Mma-Signature` header is only sent when `service.webhookSecret`
is configured** — with the secret it is an HMAC-SHA256 over
`timestamp + "." + body`; without it the callback arrives **unsigned**, so do
not trust the callback unless you configured a secret (or keep pull as your
source of truth). Retries use backoff + jitter; deduplicate by `X-Mma-Event-Id`
and verify the timestamp. Pull stays available even if push is undeliverable.

## Idempotency, cancel, timeout, retention

- `Idempotency-Key` header → the same `jobId`/response for a repeated identical
  body; a different body → `409`. TTL `service.idempotencyTtlHours`.
- `POST /v1/tasks/:jobId/cancel` → cooperative stop (`Agent.shutdown`) →
  `cancelled`.
- `timeoutMs` on submit → `failed` with `error.type` = `…/timeout`.
- Terminal results are pruned after `service.resultRetentionDays`; long-term
  storage is your control plane's job.

## Ops

| Check | Endpoint |
|---|---|
| liveness | `GET /v1/health` |
| readiness (config loaded, provider reachable) | `GET /v1/ready` |
| contract (machine) | `GET /v1/openapi.json` |
| contract (human) | `GET /v1/docs` |

On `SIGINT`/`SIGTERM` the service stops accepting, cancels pending questions and
drains the pool. If a provider is unreachable, readiness reports `503`
(`provider-unavailable`, retriable); a crashed process is detected via health and
restarted by your supervisor — sessions survive, in-flight work is retried by
`Idempotency-Key`.

## Known limitations (v1)

- No in-process multi-tenant (pool/bridge) — use one process per tenant.
- Event resume is in-memory (bounded per session); after a process restart,
  re-sync from `GET /v1/tasks/:jobId`.
- No scheduler/batch fan-out, no WebSocket, no public library SDK.
