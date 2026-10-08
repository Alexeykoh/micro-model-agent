# Agent Service API v1

Запуск: `mma serve [-p <port>] [--host <addr>] [--token <t>]`. Рантайм —
`src/modules/service/` — поднимает тот же агент, что CLI/REPL/web, но отдаёт
формальный HTTP-контракт для внешних систем (боты, бэкенды, cron).

Design spec: [../specs/2026-10-08-agent-service-api-design.md](../specs/2026-10-08-agent-service-api-design.md).
Реализация: [../plans/2026-10-08-agent-service-api.md](../plans/2026-10-08-agent-service-api.md).

## Модель

- **1 процесс = 1 тенант** (silo): свой `MMA_CONFIG_DIR`, workspace, память.
  Control plane интегратора маппит tenant → процесс.
- **Сессия** — внутренний `SessionManager`-id + опц. `externalRef` (ключ
  интегратора). Живёт в общем сторе, переживает рестарт.
- **Задача (job)** — ход над сессией: `interactive` (вопросы разрешены) или
  `job` (автономная). Состояние выводится из `RunPool` + реестра задач; pull —
  источник правды.

## Конфиг (`service.*`)

| Ключ | Дефолт | Смысл |
|---|---|---|
| `service.port` | `7331` | порт (флаг `-p` важнее) |
| `service.host` | `127.0.0.1` | адрес; не-loopback требует токен |
| `service.token` | — | `Authorization: Bearer` (control plane → runtime) |
| `service.resultRetentionDays` | `7` | хранение терминальных результатов |
| `service.idempotencyTtlHours` | `24` | TTL `Idempotency-Key` |
| `service.syncWaitMs` | `10000` | верхняя граница `wait:true` |
| `service.maxQueueLength` | `5` | FIFO-очередь задач на сессию |
| `service.callbackTimeoutMs` | `10000` | таймаут webhook-доставки |
| `service.webhookSecret` | — | секрет HMAC подписи вебхуков |

Env: `MMA_SERVICE_PORT`, `MMA_SERVICE_HOST`, `MMA_SERVICE_TOKEN` (важнее
конфига). Доступно в `/config` и web Settings → Network → Agent Service API.

## Endpoints

База `/v1`; тела — JSON; ошибки — `application/problem+json`.
`GET /v1/health` и `GET /v1/ready` — без auth (liveness/readiness оркестратора);
остальное требует bearer-токен, если задан.

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/v1/sessions` | создать сессию (`{name?, externalRef?}`) |
| `GET` | `/v1/sessions` | список (`?externalRef=&status=`) |
| `GET` | `/v1/sessions/:id` | метаданные + статус |
| `DELETE` | `/v1/sessions/:id` | удалить (204); занятая → 409 |
| `POST` | `/v1/sessions/:id/tasks` | сабмит задачи |
| `GET` | `/v1/tasks/:jobId` | статус/результат (Job-объект) |
| `POST` | `/v1/tasks/:jobId/cancel` | кооперативная отмена |
| `POST` | `/v1/tasks/:jobId/answer` | ответ на `question` (interactive) |
| `GET` | `/v1/sessions/:id/events` | поток событий (SSE) |

### Сабмит

```jsonc
POST /v1/sessions/:id/tasks
Idempotency-Key: <uuid>                 // опц.
{
  "input": "…",
  "mode": "job",                        // interactive | job
  "output": { "format": "json", "schema": { … } },  // опц.
  "toolAllowlist": ["read_file"],       // опц.
  "timeoutMs": 120000,                  // опц.
  "wait": false,                        // опц.
  "callbackUrl": "https://…"            // опц. (HMAC push)
}
```

Ответ: `202 Accepted` + `Location`/`Retry-After` + `{jobId,status,statusUrl}`
(терминальная задача или `wait:true`, уложившаяся в `syncWaitMs` → `200` +
Job-объект). Повтор с тем же `Idempotency-Key` и телом → тот же `jobId`; другое
тело → `409`.

### Job-объект

```jsonc
{
  "jobId": "job_…", "sessionId": "ses_…",
  "status": "queued|running|succeeded|failed|cancelled|timeout|waiting_input",
  "mode": "job",
  "result": { "text": "…", "data": { … } },   // при succeeded
  "usage": { "promptTokens": 0, "completionTokens": 0, "costUsd": 0 },
  "error": { /* Problem Details */ },
  "createdAt": "…", "startedAt": "…", "finishedAt": "…"
}
```

`GET /v1/tasks/:jobId` отдаёт **тот же объект**, что и webhook-колбэк.

## SSE

```
id: <seq>
event: <type>
data: { "v":1, "seq", "ts", "type", "sessionId", "taskId", "data" }
```

Типы: `task.accepted/started/finished/failed/cancelled/waiting_input`,
`text.delta`, `reasoning.delta`, `phase`, `tool.start`, `tool.end`, `question`,
`plan`, `error`. `seq` монотонный на сессию; resume —
`Last-Event-ID` или `?since=<seq>` из in-memory буфера (best-effort между
рестартами; статус всегда доступен pull'ом). Keep-alive `: ping` каждые 20 с;
`X-Accel-Buffering: no`. Закрытие потока отменяет **только** интерактивную
задачу; `job` продолжается.

## Ошибки (RFC 9457)

`type`-URI стабильны (клиент ветвится по ним): `validation`, `idempotency-conflict`,
`queue-full`, `rate-limited`, `no-session`, `no-task`, `tool-forbidden`,
`output-invalid`, `provider-unavailable`, `timeout`, `internal`. Плюс
`is_retriable`, `retry_after_ms`, `trace_id`, `suggestions`.

## Structured output

`output:{format:"json",schema}`: рантайм добавляет инструкцию, парсит ответ
(`jsonrepair`), валидирует strict-подмножество JSON Schema (`type`, `required`,
`properties`, `items`, `enum`, `additionalProperties:false`). Провал → один
retry, затем `failed` с `error.type = …/output-invalid`.

## Webhook

На терминальном событии рантайм `POST`-ит Job-объект на `callbackUrl` с
подписью **HMAC-SHA256** по `timestamp + "." + body`, заголовки
`X-Mma-Timestamp` (RFC 3339), `X-Mma-Event-Id` (стабилен между ретраями),
`X-Mma-Signature`. Ретраи — exponential backoff + jitter; 4xx (кроме 429) не
ретраятся. Pull доступен и при недоставке push.

## Наблюдаемость и изоляция

`session.jsonl` — журнал сессии (как в других режимах); `usage` per task;
тенант — из auth-заголовков (`X-Mma-Principal` и т.п.), не из тела/prompt.
