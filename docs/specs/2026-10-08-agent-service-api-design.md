# Agent Service API — Design Spec

**Status:** Draft (2026-10-08)
**Ветка:** `docs/agent-service-api-design`
**Тип:** продуктовая способность (новый рантайм), additive к ядру
**References:** см. §17 (внешние источники, на которых основаны решения)

---

## 1. Цель

Сделать из MMA **официальный агент-сервис**: долгоживущий процесс, который
принимает задачи от внешних систем (боты, бэкенды, cron) по **стабильному
версионируемому HTTP-контракту** и решает их агентом.

Сегодня агента можно запустить только как CLI-приложение. `mma web`
(`src/modules/webui/`) технически уже сервис, но спроектирован как **сервер
веб-UI**: UI-образные события, браузерный auth, ориентированность на DOM. Как
публичный продуктовый контракт он не предназначен.

Цель — отдельный формальный **Agent Service API v1** и рантайм, который его
обслуживает, с сохранением всей текущей функциональности агента.

## 2. Non-goals

- Не менять агентскую петлю (`src/core/agent.ts`), MoE, тулы, security, контекст.
- Не менять терминальный REPL и браузерный `mma web` (контракты не трогаются).
- Не строить control plane целиком (tenant identity, квоты, биллинг) — это
  ответственность интегратора; спека задаёт только границу и формат tenant-контекста.
- Scheduler, batch-веер, WebSocket, шардинг одной GPU, pooled-мультитенантность
  в одном процессе — вне v1 (см. §10, §16).
- Публичный библиотечный SDK (import в чужой процесс) — вне v1 (см. §16).

## 3. Контекст: что уже есть

Рантайм собирается из существующих примитивов; нового кода — минимум:

| Примитив | Файл | Роль |
|---|---|---|
| `bootstrap()` → `BootstrapResult` | `src/core/bootstrap.ts:85` | сборка агента, сессий, тулов, провайдера, `spawnSessionRunner` |
| `RunPool` | `src/modules/webui/session/session-pool.ts` | per-session single-flight + FIFO, кеш раннеров |
| `createSessionRunnerFactory` | `src/core/bootstrap/session-runner.ts:138` | изолированный `Agent`+`ContextManager`+pin на сессию |
| `makeRunAgent` | `src/modules/webui/session/run-agent.ts:65` | один ход, стрим событий, usage |
| `forwarder` | `src/modules/webui/session/forward.ts` | события хода (tool/text/phase/…) |
| `PromptIO` | `src/tools/prompt-io.ts`, `webui/session/prompt-io.ts` | интерактив `question`/`approve` |
| `SessionManager` | `src/modules/session/manager.ts` | сессии, история, `forkPinned` |
| `applyAnswersToConfig` | `src/modules/setup/apply.ts` | headless-провижининг конфига |
| `agent.shutdown()` | `src/core/agent.ts:1757` | кооперативная отмена хода |
| `RunPool`/session log | `webui/session/log-api.ts` | журнал для replay событий |

Ограничение, определяющее архитектуру: ядро **процесс-центрично** — глобальная
память (`~/.mma/memory`), синглтоны `defaultOutputBus` (`src/output/bus.ts:49`),
`getDefaultChannel` (`src/output/channel.ts:292`), `questionSeq`
(`webui/session/prompt-io.ts:16`), один активный менеджер сессий. Поэтому
единица изоляции — **процесс**, а не тенант внутри рантайма (это соответствует
индустриальному «silo»-паттерну, §17).

## 4. Архитектура

Два шара, один контракт.

```
Клиенты: боты · бэкенды · cron
      │   Agent Service API v1  (HTTP + SSE; стабильный, версионируемый)
┌─────┴───────────────────────────────┐
│ CONTROL PLANE  (ваш сервис, вне MMA) │  auth · роутинг · квоты
│                                      │  очередь задач · персистентность job'ов
│                                      │  маппинг tenant → процесс
└─────┬───────────────────────────────┘
      │   тот же API, tenant-scoped (внутренний вызов)
┌─────┴───────────────────────────────┐
│ MMA AGENT SERVICE RUNTIME            │  ОДИН процесс = ОДИН тенант
│                                      │  (bootstrap + RunPool + SessionRunner)
│  переиспользует:                     │  новое:
│   • bootstrap()                       │   • AgentServiceRuntime (lifecycle)
│   • RunPool / spawnSessionRunner      │   • публичный API-слой (≠ webui)
│   • forwarder / makeRunAgent          │   • job-executor + non-interactive
│   • PromptIO, sessions, memory        │   • типизированный event-envelope
└──────────────────────────────────────┘
```

Решения:

1. **MMA поставляет data plane** (рантайм + API). Control plane — интегратор.
2. **Единый API, два режима развёртывания.** Тот же контракт отдаёт сам
   рантайм: для single-tenant control plane не нужен; для multi-tenant перед
   N рантаймами ставится gateway (silo).
3. **Переиспользуем, а не строим заново** (таблица §3).
4. **Публичный API — отдельный слой**, не эволюция `webui/server.ts`:
   внутренности общие, контракт свой и версионируемый.
5. **Транспорт — HTTP + SSE**, не WebSocket: поток токенов однонаправленный, а
   двусторонка (`answer`/`cancel`) идёт обычными POST (§7, §17).

## 5. Модель сессии и задачи

### 5.1 Сессия

| Поле | Смысл |
|---|---|
| `id` | внутренний id MMA (`SessionManager`) |
| `externalRef` | ключ интегратора (`chat_id` / `job key` / `doc_id`) — **новое**, опц. |
| `name`, `model`, `contextWindow`, `workspace` | метаданные |
| `status` | `idle · working · queued · failed · archived` |
| `createdAt/updatedAt` | |

- Живёт в существующем сторе, переживает рестарт процесса.
- Принадлежит одному тенант-процессу; кросс-тенантного шаринга нет.
- `externalRef` добавляется в `SessionMeta` как **опциональное** поле
  (backward compatible; старые сессии читаются). Рантайм индексирует его для
  поиска (`GET /v1/sessions?externalRef=`), но **авторитетный маппинг хранит
  control plane** (§16, Q5).

### 5.2 Задача

Задача = **ход** над сессией, не новая параллельная сущность. `jobId` —
адресуемость хода; состояние выводится из сессии и журнала. Отдельная «таблица
заданий» рядом с сессиями не вводится (прецедент боли рассинхрона —
session↔plan binding).

Режимы — параметр одного контракта:

| | `interactive` | `job` |
|---|---|---|
| Вопросы (`question`/`approve`) | разрешены через обратный канал | **запрещены** (тул не регистрируется → `error.code = tool_forbidden`) |
| Набор тулов | полный / по тегам | фикс. `toolAllowlist` |
| `exitOnComplete` | false | true |
| Результат | стрим до терминального события | структурированный объект |
| Природа | синхронный, человеческий темп | **асинхронный**, машинный |

### 5.3 Жизненный цикл

```
accepted → queued → running → ┬─→ succeeded
                              ├─→ failed
                              ├─→ cancelled      (POST /v1/tasks/:jobId/cancel)
                              ├─→ timeout        (task.timeoutMs)
                              └─→ waiting_input  (только interactive)
```

- `queued`/`running` уже есть в `RunPool`.
- **Идемпотентность:** `job` принимает `Idempotency-Key`; повтор в окне → тот же
  `jobId`, повторного прогона нет (§9).
- **Отмена** кооперативная через `agent.shutdown(sessionId)`; жёсткого убийства нет.

## 6. HTTP-контракт (surface)

База: `/v1`. Все body — JSON; ошибки — `application/problem+json` (§9).

### 6.1 Endpoints

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/v1/sessions` | создать сессию (`externalRef?`, `name?`) |
| `GET` | `/v1/sessions` | список (`?externalRef=&status=`) |
| `GET` | `/v1/sessions/:id` | метаданные + текущий статус |
| `DELETE` | `/v1/sessions/:id` | удалить (204) |
| `POST` | `/v1/sessions/:id/tasks` | сабмит задачи (interactive/job) |
| `GET` | `/v1/tasks/:jobId` | статус/результат задачи |
| `POST` | `/v1/tasks/:jobId/cancel` | кооперативная отмена |
| `POST` | `/v1/tasks/:jobId/answer` | ответ на `question` (interactive) |
| `GET` | `/v1/sessions/:id/events` | поток событий (SSE, §7) |
| `GET` | `/v1/health` | liveness |
| `GET` | `/v1/ready` | readiness (конфиг загружен, провайдер доступен) |

### 6.2 Сабмит задачи

```
POST /v1/sessions/:id/tasks
Idempotency-Key: <uuid>
{
  "input": "…",
  "mode": "job",                       // interactive | job
  "output": { "format": "json", "schema": { … } },   // опц. (§8)
  "toolAllowlist": ["read_file"],      // опц., только для job
  "timeoutMs": 120000,                 // опц.
  "wait": false,                       // опц. (§8.4)
  "callbackUrl": "https://…",          // опц. push (§8.3)
  "externalRef": "news:2026-10-08:42"  // опц.
}
```

Ответ для `job`/долгих задач (асинхронно):

```
202 Accepted
Location: /v1/tasks/job_8f31a2
Retry-After: 5
{ "jobId": "job_8f31a2", "status": "queued", "statusUrl": "/v1/tasks/job_8f31a2" }
```

Ответ для `interactive`/`wait:true`/быстрых задач — `200` с Job-объектом в
терминальном состоянии (§8.4). Правило из индустрии: **не асинхронизировать то,
что стабильно завершается за десятки мс** (§17).

### 6.3 Job-ресурс (единый для pull и push)

```jsonc
{
  "jobId": "job_8f31a2",
  "sessionId": "ses_…",
  "status": "queued|running|succeeded|failed|cancelled|timeout",
  "mode": "job",
  "progress": { "percent": 40, "message": "…" },      // опц.
  "result": { "text": "…", "data": { … } },            // при succeeded
  "usage": { "promptTokens": 0, "completionTokens": 0, "costUsd": 0 },  // опц.
  "error": { /* Problem Details, §9 */ },              // при failed/timeout
  "createdAt": "…", "startedAt": "…", "finishedAt": "…"
}
```

`GET /v1/tasks/:jobId` возвращает **тот же объект**, что и push-колбэк — контракт
не расходится (§17).

## 7. Событийный поток (SSE)

### 7.1 Envelope (v1)

```
id: <seq>
event: <type>
data: { "v": 1, "seq", "ts", "type", "sessionId", "taskId", "data" }
```

- `seq` монотонный **на сессию**, переживает переподключение (используется как
  SSE `id:` → заголовок `Last-Event-ID`).
- `taskId` тегирует все события задачи (в очереди сессии задачи различимы).
- **Additive-only** в рамках v1.

### 7.2 Типы (v1)

| Группа | Типы |
|---|---|
| Задача | `task.accepted`, `task.started`, `task.finished`, `task.failed`, `task.cancelled`, `task.waiting_input` |
| Модель | `text.delta`, `reasoning.delta`, `phase` |
| Тулы | `tool.start`, `tool.end` |
| Интерактив | `question` (только interactive) |
| Наблюдаемость | `plan`, `usage`, `error` |
| Состояние | `session.updated` |

### 7.3 Операционные требования к SSE

Известные грабли продакшена (§17) — фиксируем как требования:

- **Keep-alive**: комментарий `: ping\n\n` каждые 15–30 с (ход может молчать на
  тул-вызове — прокси убивают idle-соединение).
- **Заголовки**: `Cache-Control: no-cache, no-transform`, `Content-Encoding:
  identity`, `X-Accel-Buffering: no` (nginx иначе буферизует).
- **Resume**: `?since=<seq>` / `Last-Event-ID` → догрузка из журнала сессии
  (`session.jsonl` + модель `log-api`, фильтр `since`) — второй стор не плодим.
- **Терминальный frame**: ровно один `task.*` терминального типа; клиент
  считает «тишину» смертью соединения только если keep-alive пропущен.
- **Abort propagation**: закрытие SSE/`cancel` → `agent.shutdown(sessionId)`,
  чтобы не платить за «осиротевшую» генерацию.
- **Backpressure**: сервер вправе коалесцировать `text.delta`/`usage`.
- **HTTP/2** для мультиплексирования множества потоков на меньшее число TCP.

## 8. Результат, output-контракт, доставка

### 8.1 Result object

Единый объект на терминальном событии стрима и на pull (см. §6.3).

### 8.2 Output-контракт (first-class)

При сабмите: `output: { format: "text" | "json", schema? }`.

- `schema` — **JSON Schema** (подмножество под strict-режим): только нужные
  `required`, явные типы, `enum` для закрытых множеств, `additionalProperties:
  false`, без глубокой вложенности (плоско — надёжнее, §17). Схема версионируется
  (`schema.$id` с версией), версия логируется с результатом.
- Механика: рантайм строит инструкцию + схему, парсит ответ (`jsonrepair` уже в
  зависимостях), валидирует **на стороне рантайма** (defense-in-depth — даже если
  провайдер умеет constrained decoding, локальные модели часто нет).
- Политика провала: **один** retry с текстом ошибки валидации; затем
  `error.code = output_invalid` (не сырой текст, не бесконечный retry, §17).
- `data` заполняется только в json-режиме.

### 8.3 Доставка

| Режим | Дефолт | Как |
|---|---|---|
| `interactive` | sync | подписка на `/events` до терминального события |
| `job` | **async** | `POST` → `202`+`jobId`; pull или push |

- **Pull — источник правды.** `GET /v1/tasks/:jobId` идемпотентен.
- **Push — оптимизация.** `callbackUrl` (+ секрет): на терминальном событии
  `POST` Job-объекта, подпись **HMAC-SHA256** по `timestamp + "." + body`,
  заголовки `X-Mma-Timestamp` (RFC 3339), `X-Mma-Event-Id` (стабилен между
  ретраями), `X-Mma-Signature`. Ретраи с exponential backoff + jitter;
  получатель дедуп по Event-Id и проверяет свежесть timestamp (§17).
- Даже при недоставке push — pull доступен.

### 8.4 `wait` (синхронное ожидание)

- `wait: true` + `timeoutMs` (граничится `service.syncWaitMs`, default 10 s):
  если задача завершилась — `200` с Job-объектом; иначе `202` (клиент переходит
  на pull/push, `Retry-After`).
- Триггер async — длительность вблизи таймаутов прокси/клиента (§17).

## 9. Идемпотентность, отмена, ошибки

### 9.1 Идемпотентность

- `Idempotency-Key` на сабмите. Ключ = `(endpoint, principal, key)`.
- Повтор с тем же ключом → **тот же `jobId` и тот же ответ** (в т.ч. если первый
  был ошибкой, §17). Повтор с тем же ключом и другим телом → `409`.
- TTL ключа — `service.idempotencyTtlHours` (default 24).
- **Идемпотентность side-effect тулов**: ключ `{taskId}:{stepIndex}` — на случай
  резюма/повтора мутирующего вызова (§17).

### 9.2 Отмена и таймаут

- `POST /v1/tasks/:jobId/cancel` → `agent.shutdown(sessionId)` → терминальное
  `cancelled`.
- `timeoutMs` → `task.failed(code=timeout)` + graceful shutdown.
- **Poison jobs** (детерминированный провал: `output_invalid`) **не ретраятся
  бесконечно** — терминальный `failed` (аналог dead-letter, §17).

### 9.3 Ошибки — RFC 9457 Problem Details

`Content-Type: application/problem+json`:

```jsonc
{
  "type": "https://mma.dev/errors/output-invalid",
  "title": "Structured output validation failed",
  "status": 422,
  "detail": "field `headline` missing",
  "instance": "/v1/tasks/job_8f31a2",
  "is_retriable": false,
  "retry_after_ms": 0,
  "trace_id": "...",
  "suggestions": ["provide a source text with a title"]
}
```

Стабильные `type`-URI (клиент ветвится по `type`, не по `detail`, §17):

| `type` | HTTP | Смысл |
|---|---|---|
| `…/errors/validation` | 400/422 | битый запрос/схема |
| `…/errors/idempotency-conflict` | 409 | тот же ключ, другое тело |
| `…/errors/queue-full` | 429 | очередь сессии переполнена |
| `…/errors/rate-limited` | 429 | лимит частоты |
| `…/errors/no-session` | 404 | сессии нет |
| `…/errors/tool-forbidden` | 200→`task.failed` | job-режим: тул попытался спросить/выйти за allowlist |
| `…/errors/output-invalid` | 200→`task.failed` | невалидный структурированный вывод |
| `…/errors/provider-unavailable` | 503 | бэкенд недоступен (retriable) |
| `…/errors/timeout` | 200→`task.failed` | истёк `timeoutMs` |
| `…/errors/internal` | 500 | прочее (без стеков) |

Расширения (`is_retriable`, `retry_after_ms`, `trace_id`, `suggestions`) —
не часть RFC, документируются в API-reference (§17). Стеки и внутренности
наружу не отдаём.

## 10. Изоляция и мультитенантность

### 10.1 Silo (v1)

- **1 тенант = 1 процесс**, свой `MMA_CONFIG_DIR` (конфиг, сессии, планы,
  память, плагины, скиллы) и свой workspace.
- Внутрипроцессные синглтоны → per-process = per-tenant — **без рефактора ядра**.
- Control plane маппит `tenant → процесс`; рантайм процесса не знает о соседях.

### 10.2 Tenant-контекст «едет с работой, а не с рантаймом»

Минимальный контекст (передаётся control plane'ом заголовками внутреннего
вызова): `tenantId`, `principalId`, `runId`, `tier`, `scopes`. Тенант
резолвится **из auth, не из текста модели** (§11).

### 10.3 Оси изоляции (даже в silo явно проверяем)

| Ось | Что изолировано | Механизм в v1 |
|---|---|---|
| Memory | история/память | процесс + свой `MMA_CONFIG_DIR` |
| Tools | набор тулов | `toolAllowlist` (job) + теги |
| Authz | что можно | `scopes` из tenant-контекста → allowlist |
| Cost | расход | `usage` per task/run; `CostTracker` |
| Audit | кто/что/когда | `session.jsonl` + tenant/run-поля |

**Pooled/bridge** (много тенантов в одном процессе) — вне v1; рассматривается
как отдельная спека, т.к. требует in-process tenant-контекста на всех осях (§17).

## 11. Auth и безопасность

- **Три уровня, не смешивать**: (а) end-user auth — в control plane; (б) control
  plane ↔ runtime — внутренний токен (`Authorization: Bearer`), рантайм слушает
  loopback/внутреннюю сеть; (в) push-вебхук — HMAC-подпись (§8.3).
- **Тенант только из auth**, никогда из prompt/тела запроса (иначе tenant
  spoofing, §17).
- Рантайм **не выставляется в интернет** напрямую.
- Базовая гигиена агента для сервиса: `security.paths.enabled=true`,
  `network.deniedDomains` (SSRF/приватные IP), bash-блэклист (есть), `paths`
  protected (есть). Для job — минимальный `toolAllowlist`.
- Секреты в логах — через существующий `redactContextSecrets` /
  `sanitizeLogMessageTargeted`.

## 12. Деплой, lifecycle, ops

| Точка | Смысл |
|---|---|
| `mma serve` | запуск рантайма |
| `GET /v1/health` | liveness |
| `GET /v1/ready` | готовность: конфиг загружен, провайдер доступен |
| graceful `stop` | стоп приёма → drain/abort → flush сессий |

- **Провижининг** headless через `applyAnswersToConfig`; тенант задаётся
  `MMA_CONFIG_DIR` + workspace. (Профиль использования можно спросить в wizard —
  отдельная задача — и переиспользовать те же ответы через тот же контракт.)
- **Конкурентность**: внутри процесса `RunPool` (per-session single-flight +
  FIFO, межсессионный параллелизм); лимиты `security.rateLimits.*`,
  `MAX_QUEUE_LENGTH`, `moe.parallelSubtasks`.
- **Sizing**: локальный одно-движковый бэкенд → параллелизм ≈ 1; хостед → выше.
- **Отказы**: провайдер недоступен → transient-retry, иначе
  `provider-unavailable` (retriable); падение процесса → control plane ловит по
  health, рестартит; сессии переживают, in-flight теряется → повтор по
  `Idempotency-Key`.
- Пер-тенантные квоты/бюджеты — в control plane (рантайм отдаёт `usage`).

## 13. Влияние на текущую работу агента

Оценка радиуса: **низкое на существующее поведение, среднее по новому коду.**

### Не затрагивается

- Агентская петля (`core/agent.ts`), MoE, тулы, контекст, security, hallucination.
- Терминал/REPL.
- Браузерный `mma web` — контракты и поведение.
- Провайдеры, формат сессий, память, плагины.

### Затрагивается (аддитивно)

| Область | Изменение | Риск |
|---|---|---|
| `SessionMeta` | опц. поле `externalRef` | низкий (backward compatible) |
| Конфиг | домен `service.*` (порт, токен, retention, idempotencyTtl, syncWait, limits) | низкий |
| CLI | подкоманда `mma serve` | низкий |
| i18n | новые ключи | низкий |
| Новый модуль | `src/modules/service/` (runtime, API, job-executor, envelope) | средний (объём) |
| Тесты | новые suites | низкий |

### Риски и митигации

1. **Сцепление с `webui`-внутренностями.** Переиспользуем импортом, **не
   переносим/не рефакторим** `webui/*`; envelope — адаптер над `forwarder`.
2. **Расхождение envelope с UI-событиями.** Envelope версионируется отдельно.
3. **Дубль auth/лимитов.** Переиспользуем `util.ts`/`limits.ts` как есть.
4. **Соблазн in-process multi-tenant.** Зафиксировано: изоляция = процесс.

**Итог:** ядро и текущие режимы (CLI/REPL/web) не трогаются — способность
добавляется сбоку. Основной объём — новый модуль, а не правки существующего кода.

## 14. Версионирование и совместимость

- Префикс `/v1` в пути + `v` в envelope/Job.
- Внутри v1 — **additive-only**: новые поля/типы можно; удалять/переименовывать —
  нет. Новые поля только optional.
- Deprecation: помечаем `Deprecation`/`Sunset`-заголовками, минимум один релиз
  до удаления (§17, expand-contract).
- `output.schema` версионируется через `$id`.

## 15. Тестирование

- **Unit**: envelope-маппинг из `forwarder`, очередь/idempotency, output-валидация,
  Problem Details, HMAC-подпись.
- **Integration**: submit→202→pull→succeeded; interactive→SSE→answer; cancel;
  timeout; идемпотентный повтор; `job` без вопросов (тул `question` → ошибка).
- **Contract**: SSE keep-alive/resume (`Last-Event-ID`), терминальный frame ровно
  один, `X-Accel-Buffering`.
- Существующие тесты не трогаются. Тестовые швы как в проекте (без global vi.mock).

## 16. Решённые вопросы (закрытие прежних §11)

| # | Вопрос | Решение |
|---|---|---|
| Q1 | Формат `schema` | JSON Schema (strict-подмножество): плоская, `required` минимальный, `enum`, `additionalProperties:false`; валидация рантаймом; один retry; `$id`-версия |
| Q2 | Retention | терминальные результаты — `service.resultRetentionDays` (default 7) в рантайме; idempotency-ключи — `service.idempotencyTtlHours` (24); долгосрочное хранение — control plane; опц. signed short-lived ссылка |
| Q3 | `wait:true` | Да, есть; граничится `service.syncWaitMs` (10 s); иначе `202` + `Retry-After` |
| Q4 | Имя подкоманды | `mma serve` |
| Q5 | `externalRef` | Опц. поле `SessionMeta` + индекс для поиска в рантайме; авторитетный маппинг — в control plane |

Дополнительно закрыты ранее незамеченные дыры: HTTP-семантика 202/Location/
Retry-After; Job-ресурс; RFC 9457 + расширения; SSE-ops (keep-alive/resume/
abort/буферизация); подпись вебхуков; TTL идемпотентности; стоимость/аудит на
тенанта/run; оси изоляции; версионирование; side-effect-идемпотентность тулов.

## 17. References

- Structured outputs: JSON Schema, flat schemas, validate client-side, retry-once —
  MLflow «Enforce, Validate, Observe», AgentsCamp «Structured Output 2026»,
  Fordel Studios «Structured Outputs Production».
- SSE vs WebSocket (SSE default, keep-alive, `X-Accel-Buffering`, resume,
  abort-пропагация) — LearnBackend, Zylos Research, Ably, SpeedtestHQ.
- Async API: `202 Accepted`, `Location`, `Retry-After`, Job-ресурс, idempotency
  keys (TTL), webhook как оптимизация, polling как источник правды — Technori,
  SystemDesignSchool, tianpan.co, DEV «Long-running REST APIs».
- Ошибки: RFC 9457 Problem Details (+ `is_retriable`, `retry_after_ms`,
  `trace_id`, `suggestions`).
- Вебхуки: HMAC-SHA256 + timestamp-freshness + dedup по event-id — UnifyPort.
- Мультитенантность: silo/pool/bridge, tenant-контекст «едет с работой» —
  AWS Prescriptive Guidance, Bedrock AgentCore, HyperDrift «Multi-Tenant Agent
  Architecture».
- Внутренний проектный аудит — `docs/literature.md`.

## 18. Вне scope / будущее

- Публичный библиотечный SDK (import `bootstrap`/`RunPool`): сегодня
  `src/index.ts` их не экспортирует, `package.json` без `exports`/`main`.
- Control plane (tenant identity, квоты, биллинг, scheduler).
- Batch/веер задач, WebSocket, pooled-мультитенантность, шардинг GPU.
