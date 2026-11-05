# Наблюдаемость: закрытие слепых зон (INV-15) — design

> **Дата:** 2026-11-05. **Статус:** draft. **Ветка:** `feat/observability-gaps`.
> **Основание:** аудит пяти областей (`core`, `tools`, `modules A/B`, `providers/llm`)
> по правилу 5 AGENTS.md и инварианту INV-15 архитектуры v2.
> **Нормативные источники:** [architecture v2 §1.4](./2026-10-12-architecture-v2-design.md),
> [observability.md](../agents/observability.md), [debt.md](../agents/debt.md).

## 1. Проблема

Аудит 2026-11-05 нашёл ~95 мест, где подсистема при отказе продолжает работу,
но следов отказа нет. Это не «мало логов»: в каждом случае **«сломалось» неотличимо
от «не было»** — ровно то, ради чего заведён INV-15.

Пять корневых причин, а не 95 отдельных багов:

| #   | Корень                                            | Проявление                                                                                                                                                                             |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Модульные логгеры не привязаны к каталогам        | `new Logger(...)` на уровне модуля (`mcp`, `plugins`, `indexer`, `lsp`) не получает `setLogDir/setSessionDir`; `warn` уходит только в терминал, в `app.jsonl`/`session.jsonl` — ничего |
| R2  | Сигнал есть, но не на той поверхности             | только `debug` (отсекается при `logLevel=info`), только `app.jsonl`, только terminal/UI, только HTTP-ответ                                                                             |
| R3  | Верхний слой не может отличить «нет» от «не смог» | `probe*`/`load*`/`read*` глушат причину и возвращают `null`/`false`/`[]`; вызывающий трактует это как содержательный ответ                                                             |
| R4  | Читатели журнала стирают повреждение              | `readLogEntries` → `null` → `?? []`; `loadMeta` → `null` → `404 not_found`; `truncatedTail` вычисляется и не читается                                                                  |
| R5  | Поверхность разбора фильтрует записанное          | `TRACE_LOG_TYPES`/`ALLOWED_TYPES` (`webui/session/log-api.ts`) не содержат уже существующих `DiagnosticEvent`                                                                          |
| R6  | `health()` по умолчанию `ok`                      | у `lsp`, `mcp`, `browser`, `indexer`, `skills`, `memory` нет `health()`; `/doctor` зелёный при мёртвой подсистеме                                                                      |
| R7  | Единственный путь сигнала обходится               | исключение хендлера тула глотается в `ToolExecutor.execute()`, поэтому документированный `tool_attempt` из `tool-batch-calls.ts` не эмитится                                           |

Отдельно: несколько мест выдают **ложный успех** (`approve` без `ApprovalStore`,
`process_kill` при живом процессе, `syntax-validator` без компилятора,
`download_file` с ошибкой записи как «сеть», `web_search` с нераспознанной
разметкой). Это не только наблюдаемость: пользователь/модель принимает неверное
решение. Они входят в задачу, потому что INV-15 запрещает маскировать деградацию
под успех.

## 2. Контракт

### 2.1. Поверхности и правило выбора

| Поверхность                | Что туда обязательно                                                                                        | Что туда нельзя                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `session.jsonl`            | любая деградация **внутри хода/сессии** (LLM, тулы, контекст, модули, вызванные ходом)                      | косметика, шум на каждый файл/хоп     |
| `app.jsonl`                | деградация **вне хода**: bootstrap, стартовые пробы, `/doctor`, readiness, updater, настройки, команды REPL | —                                     |
| Видимый пользователю текст | только если исход операции для него изменился (провайдер недоступен, вопрос истёк, файл не прочитан)        | диагностические детали в quiet-режиме |
| `debug`                    | дополнительная трассировка                                                                                  | быть **единственным** следом отказа   |

Правило: если сигнал относится к активной сессии — он обязан быть в
`session.jsonl`. `app.jsonl` — дополнение, не замена.

### 2.2. Таксономия сигналов

`DiagnosticEvent` — закрытый union. Не заводим тип на каждую находку: тип обозначает
**домен отказа**, `operation` — конкретное место. Новые члены:

| Тип                 | Домен                                        | Примеры `operation`                                                                                                                                                                    |
| ------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_degraded` | провайдер/транспорт LLM                      | `provider.context_probe`, `provider.capabilities_probe`, `provider.health_probe`, `provider.preflight`, `provider.build`, `provider.activate`, `llm.http_retry`, `llm.stream_fallback` |
| `provider_failover` | штатное переключение на другого провайдера   | `provider.failover`                                                                                                                                                                    |
| `tool_degraded`     | отказ внутри тула, не меняющий контракт хода | `tool.grep`, `tool.process`, `tool.images`, `tool.download.write`                                                                                                                      |
| `session_degraded`  | чтение/запись/подъём сессии                  | `session.log.read`, `session.meta.read`, `session.history.read`, `session.history_seed`, `session.dir_resolve`                                                                         |
| `module_degraded`   | жизненный цикл модуля                        | `mcp.*`, `lsp.*`, `index.*`, `skill.load`, `memory.*`, `browser.*`, `updater.*`, `plan.*`, `webui.*`                                                                                   |
| `hook_degraded`     | плагинный хук/загрузка/выгрузка              | `plugin.hook`, `plugin.load`, `plugin.unload`, `plugin.tool_def`                                                                                                                       |
| `config_degraded`   | конфиг до создания сессии                    | `config.manifest_probe`, `config.decrypt_domain`                                                                                                                                       |
| `delivery_degraded` | доставка внешнему потребителю/ввод           | `service.webhook.deliver`, `service.question.expire`, `service.question.evict`                                                                                                         |
| `ssrf_degraded`     | SSRF-гард деградировал и пропустил           | `ssrf.dns`                                                                                                                                                                             |

Существующие типы переиспользуются без расширения:

- `tool_attempt` — исключение/таймаут хендлера тула (исправить путь, §3.4);
- `verify_error` — деградация синтаксической/типовой проверки (`tool.syntax_precheck`);
- `context_degraded` — леджер, chunk-query, scan-corpus, компакция без прогресса;
- `egress_degraded` — отсутствие DLP-guard у audit-notifier;
- `admission_degraded` — деградация admission (новых применений нет).

`audit`-записи (пропуск аудита, `inconclusive` typecheck/тестов) остаются типом
`audit` со статусом и `testNote`; новый `DiagnosticEvent` для них не нужен.

### 2.3. Обязательные поля

Каждый сигнал — `Diagnostic` из `src/output/types.ts`:

- `source` — `core`, `module:<name>` или `tool:<name>` (INV-13);
- `operation` — `<домен>.<место>`, стабильное имя (по нему группирует `session diagnose`);
- `kind` — `degraded` (частично работает), `failed` (не сработало), `skipped`
  (осознанно не выполнялось), `blocked` (политика);
- `cause` — обязательна при `kind !== "ok"`; проходит `redactContextSecrets`
  и не содержит секретов/полных путей, если они закрыты политикой;
- `recoverable` — `true`, если ход продолжается;
- `detail` — только метаданные (счётчики, статусы, длительности), без содержимого.

### 2.4. Дедупликация и бюджет

Высокочастотные сигналы обязаны агрегироваться, иначе `session.jsonl` станет
нечитаемым:

- `ssrf.dns` — не чаще одного раза на хост за окно DNS-кэша (60 с), повторы в `detail.count`;
- `tool.grep` — один сигнал на вызов с `{skippedFiles, skippedDirs}`, не на каталог;
- `provider.models_refresh`/`provider.health_probe` — один на провайдера за 60 с;
- `pricing` — один на модель за сессию;
- остальные — не более одного на `operation + detail.key` за ход.

Повторяющиеся записи не подавляются молча: в последней записи окна растёт `count`.

### 2.5. Ложный успех: что меняется в поведении

Наблюдаемость не должна маскировать необходимость честного отказа. В этой задаче
меняются пять исходов (каждый — с тестом, падающим до правки):

1. `syntax-validator`: нет `bun`/`node`/таймаут → запись **не отклоняется** по
   выдуманной «синтаксической ошибке», а проходит с `verify_error` и видимой пометкой.
2. `approve`: нет `ctx.approvals` → `success:false`, а не «одобрено».
3. `process_kill`: ОС не подтвердила kill → `success:false`, запись не помечается `killed`.
4. `download_file`: ошибка `mkdir/writeFileSync` → `fs_write_failed`, не `network`.
5. `web_search`: 200 без распознанных результатов → `success:false` с
   `errorMeta.code="search_unparsed"`.

## 3. Требования к реализации

### 3.1. Логгер модуля — только из `ModuleCtx`

Запрещён `new Logger(...)` на уровне модуля. Модуль получает логгер в `setup(ctx)`
(`ModuleCtx.logger` уже привязан к каталогам и источнику `module:<name>`).
Для кода вне `setup` (диспетчер плагинов) логгер передаётся конструктором.

Гейт: `tests/arch/module-logger-binding.test.ts` сканирует `src/modules/**` и падает
на `new Logger(`; allowlist пуст. `FileOnlyLogger` LSP — явное исключение до
оплаты `lsp-session-log-events`.

### 3.2. Пробы возвращают причину

`probeProviderContext`, `probeModel`, `probeOllama`, `probeLlamaCpp`,
`probeOpenAICompatModels`, `probeModelsDev` принимают
`onDegraded?: (source: string, cause: string) => void` в опциях. Ошибка сети/HTTP/парсинга
вызывает его; «источник не поддерживается» — **не** вызывает (это не деградация).

`preflightProvider` добавляет `error?: string` в `PreflightResult` (сырой `errMsg`).
`probeProviders` уже возвращает `error` — вызывающий обязан его персистить.

### 3.3. Читатели сессии различают три состояния

Вместо `null`/`[]` вводится результат:

```ts
type SessionRead<T> =
  | { status: "ok"; value: T; truncated?: boolean }
  | { status: "missing" }
  | { status: "unreadable"; cause: string };
```

`SessionStore.loadMetaWithStatus`, `readLogEntries` (или его обёртка) и
`SessionManager.loadSessionLog` возвращают его. `missing` — штатный `404`;
`unreadable` — `500 problem+json` + `session_degraded`; `truncated` — `200` +
`truncated: true` + сигнал. Пустой массив больше не означает «не прочитано».

### 3.4. Исключение тула не теряется

`ToolExecutor.execute()` в `catch` вызывает
`ctx.onDiagnostic({ source: \`tool:${call.name}\`, operation: "tool.execute",
kind: "failed", cause })`. Запись из `tool-batch-calls.ts`остаётся страховкой;
дубль отсекается по`toolCallId`(в`tool_attempt`добавляется`detail.toolCallId`).

`admissionDiagnosticSink` перестаёт угадывать по умолчанию: `OPERATION_SIGNALS`
становится полным (все операции из §2.2), неизвестная операция в тесте — ошибка,
в рантайме — `tool_degraded`.

### 3.5. Trace не фильтрует сигналы

`DiagnosticEvent` переводится из type-only в runtime-массив:

```ts
export const DIAGNOSTIC_EVENTS = ["tool_attempt", …] as const;
export type DiagnosticEvent = (typeof DIAGNOSTIC_EVENTS)[number];
```

`webui/session/log-api.ts` строит `TRACE_LOG_TYPES`/`ALLOWED_TYPES` из этого
массива. Гейт: каждый `DiagnosticEvent` входит в `ALLOWED_TYPES`; новый член без
правки whitelist невозможен.

### 3.6. `health()` вместо `ok` по умолчанию

`lsp`, `mcp`, `browser`, `indexer`, `skills`, `memory` реализуют `health()`:
`{ status: "degraded", reason }` при крахе серверов/отсутствии Chromium/неполном
индексе/битом файле. Новый тип события не нужен — `/doctor` читает `health()`.

### 3.7. Пользовательские строки — через `t()`

Видимые сообщения (провайдер недоступен, вопрос истёк, файл не прочитан, аудит
пропущен) добавляются в `en.json`/`ru.json` симметрично. Техническая причина
остаётся в журнале, в чат — одна короткая строка (STYLE.md, quiet by default).

## 4. Карта работ

### W0. Контракт и инфраструктура (первым, без изменения поведения)

- новые члены `DiagnosticEvent`, `DIAGNOSTIC_EVENTS`, `SessionRead`;
- `OPERATION_SIGNALS` и `admissionDiagnosticSink`;
- `TRACE_LOG_TYPES`/`ALLOWED_TYPES` из union;
- привязка логгеров модулей;
- обновление `docs/agents/observability.md` (инвентарь + новые сигналы) и
  `debt.md` (`lsp-session-log-events` расширяется на `exit`, `lsp_check_degraded`;
  чтение леджера — отдельная строка или часть `ledger-write-diagnostics`).

**Результат:** типы и гейты есть, поведение не меняется.

### W1. Провайдер и LLM

| Место                                                            | Что закрыть                                 | Сигнал                                                                              |
| ---------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `providers/preflight.ts:121-126`                                 | причина `unreachable/timeout/401`           | `provider.preflight`                                                                |
| `providers/health.ts:47-56`, `cli/repl-start.ts:148-157`         | падение активного и соседей                 | `provider.health_probe`                                                             |
| `core/agent/provider-phase.ts:167-169`                           | context-probe при `/model`, `/provider use` | `provider.context_probe`                                                            |
| `core/bootstrap/provider-phase.ts:157-208`                       | capabilities/context/reasoning пробы        | `provider.capabilities_probe`, `provider.context_probe`, `provider.reasoning_probe` |
| `llm/provider-context.ts:111-185`, `llm/native-context.ts:54-61` | причина в нижнем слое                       | `onDegraded` → тот же сигнал                                                        |
| `providers/factory.ts:46-48`, `managed.ts:54-58`                 | успешный failover                           | `provider_failover`                                                                 |
| `providers/create.ts:18-22`, `manager.ts:190-194`                | неизвестный type, `active` не найден        | `provider.build`, `provider.activate`                                               |
| `llm/openai-request.ts:103-137`                                  | 429/5xx/сеть, `Retry-After`                 | `llm.http_retry`                                                                    |
| `llm/openai-stream.ts:67-114`, `openai-compat.ts:117-133`        | переспрос/фолбэк на non-stream              | `llm.stream_fallback`                                                               |
| `modules/setup/discovery.ts`, `webui/settings/*probe*`           | причина пробы мастера                       | `provider.*` в `app.jsonl`                                                          |
| `llm/openai-rate-limit.ts:20-31`                                 | ожидание слота                              | `llm.rate_limit_wait` (debug + detail)                                              |

Тесты: `tests/providers/probe-diagnostics.test.ts`, `provider-failover-signal.test.ts`,
`tests/llm/http-retry-signal.test.ts`, `tests/core/provider-probe-signal.test.ts`.

### W2. Тулы и enforcement

| Место                                                           | Что закрыть                     | Сигнал                                  |
| --------------------------------------------------------------- | ------------------------------- | --------------------------------------- |
| `tools/executor.ts:198-204`                                     | исключение хендлера             | `tool_attempt` (исправление пути)       |
| `security/dns-guard.ts:42-48`                                   | DNS fail-open                   | `ssrf_degraded` + дедуп по хосту        |
| `tools/grep-js.ts:56-109`, `grep-tool.ts:49-60`                 | пропущенные файлы/каталоги      | `tool.grep` (сводка)                    |
| `core/context/chunk-query.ts:151-157`, `scan-corpus.ts:103-108` | упавшие чанки/файлы             | `context_degraded` + пометка в output   |
| `modules/processes/registry.ts:95-100,228-237`                  | вытеснение/убийство             | `tool.process` + честный `process_kill` |
| `tools/syntax-validator.ts:189-218`                             | нет компилятора                 | `verify_error`, запись не блокируется   |
| `tools/download-file.ts:107-131`                                | ошибка записи                   | `tool.download.write`                   |
| `tools/approve.ts:56-58`                                        | нет `ApprovalStore`             | `success:false`                         |
| `core/context/pending-images.ts:16-21`                          | вытеснение картинок             | `tool.images` (`skipped`)               |
| `tools/path-enforcement.ts:62-70`, `executor-security.ts:84-94` | блок не попал в security-журнал | `logSecurityBlock`                      |
| `security/audit-log.ts:87-107`, `session-encryption.ts:162-179` | потеря аудита/шифрования        | `logStructured`/`persist`               |
| `security/path-validator.ts:21-41`                              | symlink-контейнмент отключён    | `module_degraded` (+ `kind:"degraded"`) |
| `tools/mcp-call.ts:72-86`                                       | disconnect/полу-инициализация   | `module_degraded` (`mcp.*`)             |
| `tools/web-search.ts:110-226`                                   | нераспознанная разметка         | `tool_degraded` + `success:false`       |

Тесты: `tests/tools/executor-signal.test.ts`, `tests/security/dns-guard-signal.test.ts`,
`tests/tools/grep-skip-signal.test.ts`, `tests/tools/false-success.test.ts`.

### W3. Сессия и поверхности

| Место                                                           | Что закрыть                           | Сигнал                         |
| --------------------------------------------------------------- | ------------------------------------- | ------------------------------ |
| `webui/session/history-api.ts:207-211`                          | нечитаемая сессия → пустой транскрипт | `500` + `session.history.read` |
| `webui/session/log-api.ts:232-235`, `session/log-file.ts:69-73` | пустой Trace, `truncatedTail`         | `session.log.read`             |
| `session/store.ts:128-153`                                      | битая мета = «сессии нет»             | `session.meta.read`            |
| `session/manager.ts:222-228`                                    | двойное глушение                      | `session.log.read`             |
| `bootstrap/session-runner-wiring.ts:233-244`                    | пустая история раннера                | `session.history_seed`         |
| `bootstrap/session-runner.ts:114-119`                           | нет `sessionDir`                      | `session.dir_resolve`          |

Тесты: `tests/webui-session-read-status.test.ts`, `tests/core/session-read-signal.test.ts`,
`tests/arch/trace-signal-whitelist.test.ts`.

### W4. Модули

| Модуль  | Что закрыть                                                                   | Сигналы                                                 |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| MCP     | discovery/connect/stream/exit/cleanup, `health()`                             | `module_degraded`                                       |
| LSP     | workspace symbol, startup check, read document, scan, server exit, `health()` | `module_degraded`; `lsp-session-log-events` расширяется |
| Indexer | build/refresh/walk/watch/cache write, `health()`                              | `module_degraded`                                       |
| Skills  | битый/нечитаемый скилл                                                        | `module_degraded`                                       |
| Memory  | prefs read, validator, encrypt/decrypt, `health()`                            | `module_degraded`                                       |
| Browser | direct launch, bridge spawn, wait load, cookies, close, `health()`            | `module_degraded`                                       |
| Plugins | hook/load/unload/tool-def + логгер из `ModuleCtx`                             | `hook_degraded`                                         |

Тесты: `tests/modules/mcp/lifecycle-signal.test.ts`,
`tests/modules/lsp/check-signal.test.ts`, `tests/modules/indexer/signal.test.ts`,
`tests/modules/memory/degraded.test.ts`, `tests/modules/browser/signal.test.ts`,
`tests/modules/plugins/hook-signal.test.ts`, `tests/arch/module-health.test.ts`.

### W5. Сервис, web, updater, аудит

| Место                                                     | Что закрыть                | Сигнал                                                                          |
| --------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| `service/api/tasks-runner.ts:195-215`                     | недоставка webhook         | `delivery_degraded`                                                             |
| `service/runtime/prompt-io.ts:70-87`                      | TTL/вытеснение вопроса     | `delivery_degraded` + видимая строка                                            |
| `service/api/health.ts:47-76`                             | readiness-проба упала      | `provider_degraded` в `app.jsonl`                                               |
| `webui/settings/model-cache.ts:41-58`                     | пустой список моделей      | `provider_degraded`                                                             |
| `webui/settings/reconfigure.ts:34-40`                     | раннер не применил конфиг  | `module_degraded`                                                               |
| `webui/file/*-api.ts`                                     | `404` вместо ошибки чтения | `module_degraded` + `500`                                                       |
| `updater/factory.ts:73-91`, `versions.ts`                 | сборка/prune молчит        | `app.jsonl` (`logSilent`)                                                       |
| `execution/final-audit.ts:140-143`                        | аудит пропущен             | `audit` со `status:"skipped"`                                                   |
| `execution/audit-test-run.ts:63-68`, `auditor.ts:207-212` | инфра-сбой = «чисто»       | `audit.testNote="inconclusive: …"`; оплата `DEBT(audit-typecheck-inconclusive)` |
| `pricing/index.ts:47-54`                                  | цена неизвестна            | `logStructured` (один раз на модель)                                            |

Тесты: `tests/service/webhook-delivery-signal.test.ts`,
`tests/service/question-expiry-signal.test.ts`, `tests/modules/execution/audit-skip-signal.test.ts`,
`tests/webui-read-error-status.test.ts`.

### W6. Ядро, конфиг, план

| Место                                                | Что закрыть                  | Сигнал                                     |
| ---------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| `core/context/ledger.ts:58-63`                       | леджер не прочитан           | `context_degraded`                         |
| `bootstrap/startup-plan.ts:17-21,60-70`              | план не восстановлен         | `module_degraded` (`plan.restore_startup`) |
| `cli/repl-commands-session.ts:90-94,142-147,221-227` | switch/forget упал           | `module_degraded` + видимая строка         |
| `bootstrap/config-phase.ts:75-118`                   | notifier/guard/манифест      | `egress_degraded` + `logSilent`            |
| `cli/main.ts:155-161`, `config/domains.ts:80-129`    | «конфига нет»/не расшифрован | `config_degraded`                          |
| `core/agent/compaction.ts:242-263` (legacy)          | компакция не уменьшила       | `compaction` `skipped_no_reduction`        |
| `core/agent/turn-output.ts:130-132`                  | форс-финал пуст              | `error` (`turn.finalize_without_tools`)    |

Тесты: `tests/core/ledger-read-signal.test.ts`, `tests/core/plan-restore-signal.test.ts`,
`tests/config/domain-decrypt-signal.test.ts`.

## 5. Гейты

Новые проверки (правило 5):

1. `tests/arch/observability-coverage.test.ts` — расширяется автоматически: каждый
   новый `DiagnosticEvent` обязан иметь тест-эмит и строку в `observability.md`.
2. `tests/arch/trace-signal-whitelist.test.ts` — все `DiagnosticEvent` в
   `ALLOWED_TYPES`; `SessionLogEntry["type"]` с диагностикой не теряется в Trace.
3. `tests/arch/module-logger-binding.test.ts` — нет `new Logger(` в `src/modules/**`.
4. `tests/arch/health-coverage.test.ts` — у `lsp/mcp/browser/indexer/skills/memory`
   есть `health()`, возвращающий `degraded` при отказе (инъекция стаба).
5. `tests/tools/executor-signal.test.ts` — throw хендлера даёт ровно одну запись
   `tool_attempt` (не дубль).
6. `tests/arch/session-read-status.test.ts` — `unreadable` не превращается в `[]`
   ни в одном читателе.

Общие критерии готовности (правило 7):

- `bun test` и `bun run quality` зелёные;
- для каждого сигнала есть тест, **падающий без правки**;
- живой прогон: упавший провайдер/тул/модуль виден в `session.jsonl` и, где нужно,
  одной строкой в чате;
- секреты и PII в `cause/detail` отсутствуют (`redactContextSecrets`).

## 6. Границы задачи

Не входит:

- изменение fail-open политики (кроме пяти ложных успехов из §2.5);
- новые панели UI, экспорт телеметрии, смена ротации логов;
- «молчащие» места, уже признанные безобидными в `observability.md`
  (парсинг недоверенного ввода, best-effort запись самого лога, косметика);
- долги, которые остаются долгами: `lsp-protocol-error-counter`,
  `webui-csp-inline-script`, `memory-at-rest` (оплачен), `ledger-write-diagnostics`
  (запись; чтение закрывается в W6).

## 7. Риски

- **Объём `session.jsonl`.** Без дедупликации §2.4 сигналы удвоят журнал; тест на
  кап повторов обязателен.
- **Смена HTTP-контракта.** `500` на нечитаемый лог/историю вместо `200 []` может
  сломать клиентов; веб-UI должен показать ошибку, а не пустоту.
- **Шум от модулей.** Падение MCP/LSP на старте может давать сигнал на каждый
  сервер; нужен дедуп по `server` за процесс.
- **Ложная точность.** `kind:"degraded"` не должен скрывать `failed`; для
  несостоявшейся проверки — `skipped`, а не `ok`.

## 8. Порядок

W0 → (W1, W2, W3 параллельно) → W4 → (W5, W6). W0 без изменения поведения, чтобы
волны не конфликтовали в `src/output/types.ts` и `log-types.ts`. Каждая волна —
отдельный PR в `dev` со своими гейтами; `observability.md` обновляется в той же
волне, что и сигнал.
