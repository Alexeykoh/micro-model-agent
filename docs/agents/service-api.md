# Agent Service API v1

Запуск: `mma serve [-p <port>] [--host <addr>] [--token <t>]`. Рантайм —
`src/modules/service/` — поднимает тот же агент, что CLI/REPL/web, но отдаёт
формальный HTTP-контракт для внешних систем (боты, бэкенды, cron).

Design spec: [../specs/2026-10-08-agent-service-api-design.md](../specs/2026-10-08-agent-service-api-design.md).
Реализация: [../plans/2026-10-08-agent-service-api.md](../plans/2026-10-08-agent-service-api.md).

## Discovery: спека и страница

Контракт **объявляет себя сам** — искать его по репозиторию не нужно:

| Путь | Что отдаёт | Auth |
|---|---|---|
| `GET /v1/openapi.json` | OpenAPI 3.1 документ (Swagger UI / Redoc / Postman / Insomnia, генерация клиента) | без токена |
| `GET /v1/docs` | та же выжимка как HTML: quickstart cURL, таблица эндпоинтов, коды ответов | без токена |

Обе выводятся при старте (`cli.serve_docs`) и лежат в exempt-списке
`OPEN_PATHS` (`src/modules/service/server.ts`) рядом с `/v1/health` и
`/v1/ready`: это описание публичного API, а не данные тенанта. Tenant-маршруты
по-прежнему требуют bearer.

Источник правды — одна таблица операций
`src/modules/service/openapi/operations.ts`: из неё собираются и OpenAPI
документ (`openapi/document.ts`), и страница (`openapi/docs-page.ts`), и
guard-тест `tests/service/openapi.test.ts`, который падает, если маршрут
появился/исчез без записи в таблице. Новый эндпоинт = строка в `OPERATIONS`,
дальше спека, страница и тест следуют сами.

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
| `service.tenant` | — | тенант процесса (silo); `X-Mma-Tenant` сверяется с ним |
| `service.resultRetentionDays` | `7` | хранение терминальных результатов |
| `service.idempotencyTtlHours` | `24` | TTL `Idempotency-Key` |
| `service.syncWaitMs` | `10000` | верхняя граница `wait:true` |
| `service.maxQueueLength` | `5` | FIFO-очередь задач на сессию |
| `service.callbackTimeoutMs` | `10000` | таймаут webhook-доставки |
| `service.webhookSecret` | — | секрет HMAC подписи вебхуков |

Env: `MMA_SERVICE_PORT`, `MMA_SERVICE_HOST`, `MMA_SERVICE_TOKEN`,
`MMA_SERVICE_TENANT` (важнее конфига). Доступно в `/config` и web Settings →
Network → Agent Service API.

## Endpoints

База `/v1`; тела — JSON; ошибки — `application/problem+json`.
`GET /v1/health`, `GET /v1/ready` и discovery (`/v1/openapi.json`, `/v1/docs`) —
без auth (liveness/readiness оркестратора и описание контракта); остальное
требует bearer-токен, если задан.

| Метод | Путь | Назначение | Auth |
|---|---|---|---|
| `GET` | `/v1/health` | liveness | — |
| `GET` | `/v1/ready` | readiness (проба провайдера) | — |
| `GET` | `/v1/openapi.json` | спецификация контракта (OpenAPI 3.1) | — |
| `GET` | `/v1/docs` | человеческая страница контракта | — |
| `POST` | `/v1/sessions` | создать сессию (`{name?, externalRef?}`) | bearer |
| `GET` | `/v1/sessions` | список (`?externalRef=&status=`) | bearer |
| `GET` | `/v1/sessions/:id` | метаданные + статус | bearer |
| `DELETE` | `/v1/sessions/:id` | удалить (204); занятая → 409 | bearer |
| `POST` | `/v1/sessions/:id/tasks` | сабмит задачи | bearer |
| `GET` | `/v1/tasks/:jobId` | статус/результат (Job-объект) | bearer |
| `POST` | `/v1/tasks/:jobId/cancel` | кооперативная отмена | bearer |
| `POST` | `/v1/tasks/:jobId/answer` | ответ на `question` (interactive) | bearer |
| `GET` | `/v1/sessions/:id/events` | поток событий (SSE) | bearer |

Вопрос принимается только для **своей** задачи: id вопроса из чужой задачи →
`404`, задача остаётся в `waiting_input`. Висящий вопрос живёт `30` минут
(дальше ход получает пустой ответ), на процесс — не больше `100` висящих
вопросов (самый старый вытесняется).

### Сабмит

```jsonc
POST /v1/sessions/:id/tasks
Idempotency-Key: <uuid>                 // опц.
{
  "input": "…",
  "mode": "job",                        // interactive | job
  "output": { "format": "json", "schema": { … } },  // опц.
  "toolAllowlist": ["read_file"],       // опц., только job; строго (теги/alwaysOn не обходят)
  "timeoutMs": 120000,                  // опц.
  "wait": false,                        // опц.
  "callbackUrl": "https://…"            // опц. (HMAC push)
}
```

**Auth-заголовки** control plane (tenant-контекст «едет с работой», §10.2/§11):
`X-Mma-Tenant`, `X-Mma-Principal`, `X-Mma-Run`, `X-Mma-Tier`, `X-Mma-Scopes`
(comma-separated). Резолвятся только из auth, не из тела; пишутся в
`session.jsonl` записью `service_task`.

Тенант — свойство **процесса** (silo: 1 процесс = 1 тенант), а не запроса:
`service.tenant` (env `MMA_SERVICE_TENANT`). Значение `X-Mma-Tenant` только
сверяется с ним; чужой/неизвестный тенант → `403 …/tenant-mismatch` до
маршрута, поэтому задачи, сессии и SSE другого тенанта недоступны. Без
`service.tenant` процесс обслуживает один безымянный тенант. `X-Mma-Principal`
и `X-Mma-Run` — audit-метки (не повышают прав); `X-Mma-Tier`/`X-Mma-Scopes`
рантайм не доверяет — они принадлежат control plane.

В `job`-режиме `toolAllowlist` применяется **строго** к набору тулов раннера
(теги и `alwaysOn` не обходят). Попытка вызвать интерактивный тул или тул вне
allowlist завершает задачу `failed` с `error.type = …/tool-forbidden`.

Ответ: `202 Accepted` + `Location`/`Retry-After` + `{jobId,status,statusUrl}`
(терминальная задача или `wait:true`, уложившаяся в `syncWaitMs` → `200` +
Job-объект). Повтор с тем же `Idempotency-Key` и телом → тот же `jobId`; другое
тело → `409`. Ключ скоупится **тенантом процесса**, а principal первого
использования запоминается: повтор под другим `X-Mma-Principal` → `409
…/idempotency-conflict` без Job-объекта (чужой результат не отдаётся). Тела
сравниваются канонически (порядок ключей не важен).

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

`type`-URI стабильны (клиент ветвится по ним): `validation`, `tenant-mismatch`,
`idempotency-conflict`, `queue-full`, `rate-limited`, `no-session`, `no-task`,
`tool-forbidden`, `output-invalid`, `provider-unavailable`, `timeout`, `internal`.
Плюс `is_retriable`, `retry_after_ms`, `trace_id`, `suggestions`.

## Structured output

`output:{format:"json",schema}`: рантайм добавляет инструкцию, парсит ответ
(`jsonrepair`), валидирует strict-подмножество JSON Schema (`type`, `required`,
`properties`, `items`, `enum`, `additionalProperties:false`). Провал → один
retry, затем `failed` с `error.type = …/output-invalid`.

## Webhook

На терминальном событии рантайм `POST`-ит Job-объект на `callbackUrl` с
заголовками `X-Mma-Timestamp` (RFC 3339) и `X-Mma-Event-Id` (стабилен между
ретраями). `X-Mma-Signature` (HMAC-SHA256 по `timestamp + "." + body`)
отправляется **только если настроен `service.webhookSecret`** — без секрета
колбэк приходит неподписанным, и доверять ему нельзя (pull остаётся источником
правды). Ретраи — exponential backoff + jitter; 4xx (кроме 429) не ретраятся.

## Наблюдаемость и изоляция

`session.jsonl` — журнал сессии (как в других режимах); `usage` per task;
тенант — из auth-заголовков (`X-Mma-Principal` и т.п.), не из тела/prompt.
