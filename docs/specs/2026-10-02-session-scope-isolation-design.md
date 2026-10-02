# Session-Scope Isolation — Design Spec

**Status:** Draft (2026-10-02)
**Ветка:** `docs/web-session-state`
**Связано:** [Web Session State Design](./2026-10-02-web-session-state-design.md),
[Session-Scope Isolation Plan](../plans/2026-10-02-session-scope-isolation.md)

---

## 1. Контекст

`mma web` (2.11.0+) получил настоящий параллелизм: `RunPool` запускает по одному
`SessionRunner` на сессию (`src/modules/webui/session-pool.ts`,
`src/core/bootstrap/session-runner.ts`). Один `Agent` не reentrant, поэтому раннер
— это клон агента с собственными `ContextManager`, `SessionManager`
(`forkPinned`), `ExecutionModule`, `ToolContext`, реестром и менеджером плагинов
(поверх shared провайдера/стора/памяти).

Однако большая часть инфраструктуры MMA проектировалась в расчёте на **одну
активную сессию на процесс**. Параллелизм приделали сверху, не развязав
сессионно-зависимые глобальные синглтоны. Это создаёт набор скрытых кросс-сессионных
утечек, которые не видны в однопоточном терминале, но ломают параллельный web:
логи, аудит, identity провайдера, поток вывода, реестр процессов — всё смешивается
между сессиями.

Этот дефект — **фундамент**: пока он не закрыт, любые улучшения UI (см. спеку B)
будут строиться поверх недостоверного состояния.

## 2. Проблема (с доказательствами по коду)

### P0-1. Логгер и аудит глобальны, сессия в них одна

`SessionLogger.bindSessionDir()` мутирует **общий** `Logger` и глобальный
`_sessionAuditDir`:

- `src/core/session-logger.ts:30-43` — `this.logger.setSessionDir(dir)`,
  `this.logger.initSessionLog(meta.id)`, `setAuditSessionDir(dir)`
- `src/logger/file-log.ts:46-53` — `sessionLogPath` — одно поле на процесс
- `src/modules/security/audit-log.ts:27-51` — `_sessionAuditDir` — модуль-глобал

`SessionLogger` создаётся **на каждый ход каждого раннера** (`src/core/agent.ts:597`),
а `logger` приходит общий из bootstrap (`src/core/bootstrap.ts:196`,
`session-runner.ts:70,113`). Последний стартовавший ход перевешивает
`sessionLogPath` и `_sessionAuditDir` на себя → строки хода A попадают в лог
сессии B, аудит пишется не в каталог своей сессии.

**Последствие:** `Trace` в web сверяется с `session.jsonl`/логом
(`src/modules/webui/assets/js/sidebar.js:510+`), значит расхождение станет
системным, а не случайным.

### P0-2. Identity сессии провайдера привязана к main

`llmProvider` строится один раз с `getSessionId`, читающим **main**-менеджер:

- `src/core/bootstrap/provider-phase.ts:193-197` —
  `sessionSource` → `getSessionId` → `buildActiveProvider`
- `src/core/bootstrap.ts:194` — тот же `llmProvider` кладётся в
  `session-runner` template
- `src/llm/openai-compat.ts:646-681` — `x-opencode-session`,
  `prompt_cache_key`, `session_id` из этого `getSessionId`

Раннеры shared-провайдер не пересобирают, значит заголовки кеша/сессии для
**всех** параллельных сессий указывают на main-сессию. Для OpenCode Go
(`400 MissingSessionID`) и для prompt-cache это прямая некорректность.
Агентский `getSessionId` при `reconfigure` уже правильный
(`src/core/agent.ts:1562-1563`), но `reconfigure` штатно не вызывается.

### P0-3. OutputBus глобальный и без sessionId

- `src/output/types.ts:9-23` — `OutputEvent` не несёт сессии
- `src/output/bus.ts:49` — `defaultOutputBus` — синглтон процесса
- `src/modules/webui/log-forward.ts:27-41` — бродкастит всё всем и штампует
  `s.activeSessionId` (сессия последнего хода, а не автора события)

**Последствие:** диагностики/варнинги чужой сессии появляются в Trace активной
вкладки с чужим `sessionId`. Терминальный рендер ломать нельзя — нужен
`sessionId` в событии + фильтрация на web-стоке.

### P0-4. `create()` удаляет пустые сессии

`SessionManager.create` вызывает `pruneEmpty(id)`
(`src/modules/session/manager.ts:77-78`), который удаляет **все** пустые сессии
кроме новой (`manager.ts:143-158`). В web «новая сессия» = пустая вкладка:
открыл два новых чата → создал третий → первые два исчезли, вкладки ушли в
`dead` (404) — прямое противоречие модели вкладок.

### P0-5. Команды не гейтятся busy и реконфигурят бегущие раннеры

- `src/modules/webui/actions-api.ts:48-73` — `handleCommandPost` не проверяет
  занятость; `maybeAdoptSession` гейтит только переключение активной
- `src/modules/webui/reconfigure.ts:30-36` — `reconfigure` проходит по всем
  закешированным раннерам

`/config`/`/model`/`/provider` во время чужого хода → `agent.reconfigure`
resize ContextManager и подмена провайдера (`src/core/agent.ts:1569-1574`) на
живом раннере — гонка.

### P0-6. Глобальный kill-реестр процессов без сессии

- `src/modules/processes/runner.ts:8` — `activeChildren` — модуль-`Map`
- `src/tools/bash.ts:693` — `registerKillable(ctx.activeCallId, …)`

`call.id` приходит от LLM и не уникален глобально: две сессии легко дадут
совпадающий id → таймаут/аборт одной сессии может убить процесс другой.

## 3. Цели / Non-goals

**Цели:**
1. Убрать кросс-сессионные утечки логов, аудита, вывода, процессов.
2. Сделать identity сессии провайдера корректной для каждого раннера.
3. Убрать разрушительный авто-прунинг из пути «создать сессию».
4. Обезопасить управляющие команды (busy-gate / адресный reconfigure).
5. Подготовить фундамент для `SessionRuntime` web-слоя (спека B).

**Non-goals:**
- Изменение внешних контрактов `LLMProvider`, plugin API, `--json`.
- Терминальный REPL сохраняет однo-сессионную семантику 1:1.
- Полная изоляция процессов по workspace (см. открытые вопросы).

## 4. Целевой дизайн: `SessionScope`

Вводится явный сессионный контекст, который получают main и каждый раннер.
Не глобальный реестр — объект-владелец, передаваемый по ссылке.

```
SessionScope {
  sessionId: string
  logger: Logger            // свой FileLogWriter/sessionLogPath
  auditDir: string          // вместо глобального setAuditSessionDir
  providerIdentity: () => string | undefined
  outputTag: string         // sessionId для OutputEvent
}
```

### 4.1 Логирование (P0-1)

- `FileLogWriter` перестаёт держать единственный `sessionLogPath`: путь —
  параметр записи либо один writer на scope.
- `Logger` получает сессионный вариант (`logger.child()` уже есть —
  `src/logger/app-logger.ts:123`), раннер берёт `logger.child()` со своим
  `sessionLogPath`.
- `SessionLogger` больше не мутирует shared logger; пишет через свой.
- Аудит: `setAuditSessionDir` заменяется передачей `dir` в scope
  (убрать `_globalAuditDir`/`_sessionAuditDir` из модуль-глобалов или сделать
  их per-scope).

### 4.2 OutputEvent (P0-3)

- Добавить опциональное `sessionId?: string` в `OutputEvent`
  (`src/output/types.ts`).
- Продюсеры (логгер/петля) проставляют `sessionId` из scope.
- `log-forward` фильтрует по активной сессии клиента (или отдаёт как есть, а
  клиент раскладывает по вкладке); терминальные стоки игнорируют поле.
- Обратная совместимость: отсутствие `sessionId` = legacy, как сейчас.

### 4.3 Провайдер (P0-2)

- `getSessionId` перестаёт быть main-привязкой: раннер при создании получает
  провайдер с идентичностью своей сессии. Два варианта (выбрать в плане):
  - (a) `ProviderManager.build` принимает `sessionId` на билд, раннер строит
    свой провайдер из общего менеджера;
  - (b) фабрика раннера вызывает `agent.reconfigure(config)` сразу после
    сборки — дешёвый явный путь, уже корректный.
- Кеш-заголовки должны читать сессию раннера, не main.

### 4.4 Процессы (P0-6)

- `activeChildren` ключуется `sessionId + callId` (или scope владеет своим
  реестром). `killByCallId` принимает scope/сессию.

### 4.5 Жизненный цикл сессий (P0-4)

- Убрать `pruneEmpty` из `SessionManager.create`. Авто-прунинг — явная
  CLI-команда (`session prune`) либо web-действие «убрать пустые», а не
  побочный эффект создания.

### 4.6 Управляющие команды (P0-5)

- `handleCommandPost` при глобальном busy: либо 409/очередь, либо явный
  «команды меняют только конфиг, применяются к неактивным раннерам, активный
  подхватит после turn_end». Решение — в плане, но гонка недопустима.

## 5. Acceptance criteria

1. `tests/session-scope-isolation.test.ts`: две сессии бегут одновременно
   (мок-агенты), их file-log/audit/session.jsonl строки не пересекаются.
2. `OutputEvent.sessionId` проставлен продюсерами; web-сток не льёт чужую
   сессию в активную вкладку (тест `webui-log-forward`).
3. Кеш/сессионные заголовки провайдера для раннера сессии X несут id X
   (тест на моке `fetch`, `tests/llm/...`).
4. `SessionManager.create` не удаляет чужие пустые сессии
   (`tests/session-manager.test.ts`).
5. Команда во время чужого хода не вызывает `reconfigure` живого раннера
   (тест `webui-reconfigure`/`webui-server`).
6. `bun test` + `tsc --noEmit` + `bun run lint` зелёные; REPL-поведение не
   изменилось.

## 6. Риски и открытые вопросы

- **`defaultOutputBus` load-bearing для CLI** — менять только добавлением поля,
  не заменой шины на per-session.
- **Порог «достаточно ли параллелизма»** — если продукту хватит «много вкладок,
  один ход за раз», P0-1/2/3/6 можно отложить. Требует решения владельца.
- **Аудит per-scope** — проверить всех потребителей `auditLogFile`.
- **Процессы** — нужна ли изоляция между сессиями или общий workspace допустим.

## 7. Тестовая стратегия

- Новый DOM/harness не требуется (это серверная часть); используются
  существующие `tests/helpers/webui-server.ts`.
- Обязательные новые тесты: конкурентные (две сессии), контент-изоляция
  логов/аудита, provider identity на моке `fetch`, pruneEmpty, busy-gate команд.

## 8. Влияние на другие модули

- `src/logger/*`, `src/modules/security/audit-log.ts`, `src/output/*`,
  `src/modules/processes/runner.ts`, `src/core/bootstrap/*`,
  `src/modules/session/manager.ts`, `src/modules/webui/{actions,log-forward}.ts`.
- Терминал: семантика не меняется, но путь записи сессионного лога становится
  явным.
