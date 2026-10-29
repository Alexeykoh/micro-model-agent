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
  `job` (автономная; без `toolAllowlist` — 0 тулов и короткий промпт). Состояние
  выводится из `RunPool` + реестра задач; pull — источник правды.
- **Сессии на старте нет.** `mma serve` не создаёт сессию: клиент делает
  `POST /v1/sessions` (или использует существующую) и только потом сабмитит
  задачу. Задача на неизвестный `sessionId` → `404 noSession`.

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
| `service.webhookAllowHttp` | `false` | `http`-callback только для loopback |

Env: `MMA_SERVICE_PORT`, `MMA_SERVICE_HOST`, `MMA_SERVICE_TOKEN`,
`MMA_SERVICE_TENANT` (важнее конфига). Доступно в `/config` и web Settings →
Network → Agent Service API.

## Endpoints

База `/v1`; тела — JSON; ошибки — `application/problem+json`.
`GET /v1/health`, `GET /v1/ready` и discovery (`/v1/openapi.json`, `/v1/docs`) —
без auth (liveness/readiness оркестратора и описание контракта); остальное
требует bearer-токен, если задан. `/v1/ready` кэширует пробу провайдера на 30 с
(живой LLM-запрос не на каждый вызов) и ограничен 6 запросами в минуту на адрес
клиента (`429` с `retry_after_ms`).

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
(теги и `alwaysOn` не обходят). Не передан — у задачи **ноль** тулов и короткий
service-job промпт (без карты проекта и инструкций харнесса). Попытка вызвать
интерактивный тул или тул вне allowlist завершает задачу `failed` с
`error.type = …/tool-forbidden`.

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

Терминальная задача живёт `service.resultRetentionDays`; реестр чистится
фоновым таймером (раз в минуту) и при создании новой задачи.

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
`X-Accel-Buffering: no`. Список событий задачи ограничен 2000 (старые
вытесняются). Не больше 32 конкурентных потоков на процесс (иначе `503`),
backpressure разрывает соединение, поток без событий 120 с закрывается сам.
Закрытие потока отменяет **только** интерактивную задачу и только если у сессии
не осталось других подписчиков; `job` продолжается.

## Ошибки (RFC 9457)

`type`-URI стабильны (клиент ветвится по ним): `validation`, `tenant-mismatch`,
`idempotency-conflict`, `queue-full`, `rate-limited`, `no-session`, `no-task`,
`tool-forbidden`, `output-invalid`, `provider-unavailable`, `timeout`, `internal`.
Плюс `is_retriable`, `retry_after_ms`, `trace_id`, `suggestions`.

## Structured output

`output:{format:"json",schema}`: рантайм добавляет инструкцию, парсит ответ
(`jsonrepair`), валидирует strict-подмножество JSON Schema (`type`, `required`,
`properties`, `items`, `enum`, `additionalProperties:false`). Неизвестный `type`
и `properties`/`required` без `type:"object"` — ошибка схемы (а не молчаливый
пропуск); `null` для `required`-поля считается отсутствием. Провал → один
retry, затем `failed` с `error.type = …/output-invalid`. События первой попытки
не попадают в SSE (клиент не видит двух ответов на одну задачу), а события
retry несут в конверте `attempt: 2`.

## Webhook

`callbackUrl` обязан быть `https` (тело несёт результат хода); `http` допустим
только для loopback и только при `service.webhookAllowHttp: true` (плюс
`security.network.allowPrivateOutbound`). Приватные адреса отклоняются на сабмите
(`422`) и повторно перед доставкой.

На терминальном событии рантайм `POST`-ит Job-объект на `callbackUrl` с
заголовками `X-Mma-Timestamp` (RFC 3339, **один на доставку** — подпись стабильна
между ретраями), `X-Mma-Event-Id` (стабилен между ретраями), `X-Mma-Delivery`
(номер попытки) и `X-Mma-Signature` (HMAC-SHA256 по `timestamp + "." + body`;
только если настроен `service.webhookSecret` — без секрета колбэк приходит
неподписанным, и доверять ему нельзя; pull остаётся источником правды).

Получателю доступна контрпара `verifySignature({secret, body, signature,
timestamp, windowMs?})`: сравнение за константное время и окно replay (5 минут).

Ретраи — exponential backoff с jitter и потолком 60 с, не больше 6 попыток и
общего дедлайна 120 с. `2xx` — успех; `3xx`/`4xx` (кроме `429`) — терминальный
отказ; redirect'ы не преследуются (`redirect: manual`) — иначе конечный адресат
обошёл бы SSRF-проверку.

## Наблюдаемость и изоляция

`session.jsonl` — журнал сессии (как в других режимах); `usage` per task;
тенант — из auth-заголовков (`X-Mma-Principal` и т.п.), не из тела/prompt.
