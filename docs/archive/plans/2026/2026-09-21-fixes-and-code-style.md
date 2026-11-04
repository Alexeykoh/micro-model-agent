# План: Code Style Guide + Исправление найденных проблем

**Дата:** 2026-09-21
**Статус:** Implemented (1.3.1)
**Ожидаемый релиз:** PATCH `1.3.1` (все изменения — багфиксы/док/стиль, без нового функционала)

## Контекст

Аудит кодовой базы от энтрипоинта (`src/cli/main.ts`) через `bootstrap`, `core`, `tools`, `modules`, `ui`
выявил 22 подтверждённых проблемы. Проверка выполнена по фактическому коду (не только по отчёту
субагентов). Плюс требуется зафиксировать стандарт стиля кода (пробел в документации).

Основание — правило `## Engineering Principles` из `AGENTS.md`: каждое изменение оценивается по трём
измерениям — **реальный пользователь**, **ИИ-модель**, **смежные модули**. Дополнительно учтены
`Key Design Rules` #1–17 (`docs/agents/architecture.md`), правила версионирования
(`docs/agents/versioning.md`) и тестирования (`docs/agents/testing.md`).

## Целевые принципы

- **TDD** (правило #7): сначала тест, потом фикс.
- **Никакого silent catch** (правило #14): каждая подавленная ошибка → `logger.debug`/`logger.warn` + контекст.
- **i18n обязателен** (правило #8): все пользовательские строки → `t()`, ключи в `en.json` и `ru.json`.
- **Комментарии — на русском** (правило #15), объясняют «почему».
- **Кросс-платформенность** (правило #16): процессы, пути, шеллы.
- **Файлы ≤ 300 строк** (правило #1); не создавать god-объектов (правило #3).

---

## Этап 0 — Файл стиля кода (выполняется первым)

Создать `docs/agents/code-style.md` на базе актуальных практик TypeScript 2026
(typescript-eslint v8 strict + TS 5.9 recommended strictness, Biome-совместимые правила,
ts.dev/style). Ссылку добавить в `AGENTS.md`.

### 0.1 Форматирование

Уже действует через `.prettierrc.json`; закрепить письменно:

- 2 пробела, двойные кавычки, `trailingComma: "all"`, `printWidth: 100`, точка с запятой.

### 0.2 Типизация

- Запрещены `as any` и `as unknown as X`. Вместо них: `unknown` + type guard, `satisfies`,
  `Record<string, unknown>` с явными проверками. Единственное исключение — test seams
  (каждый каст сопровождается комментарием-обоснованием, правило #15).
- `import type` для типов из других модулей (консервативное направление к `verbatimModuleSyntax`;
  флаг пока НЕ включаем).
- Публичные функции — явный тип возврата; локальные — вывод типов.
- `unknown` в `catch` (уже обеспечивается `strict`); использовать хелпер `errMsg()`.
- Discriminated unions вместо строковых «магий».
- `interface` для расширяемых контрактов (`ToolContext`, `*Deps`), `type` — для union/alias.
- Запрет `enum`: `as const`-объекты + union-типы.

### 0.3 Консервативные рекомендации tsconfig

Включать постепенно, отдельными PATCH, без массовых правок сразу:

1. `noUncheckedIndexedAccess`
2. `noImplicitOverride`
3. `noFallthroughCasesInSwitch`
4. `exactOptionalPropertyTypes` (после рефакторинга конфиг-типов)
5. `verbatimModuleSyntax` (после правок `module`/`moduleResolution`-специфики)

### 0.4 Асинхронность

- Каждый `await` в цикле/фоне проверяет `signal.aborted` (урок `moe-executor.ts`).
- `Promise` без `await` → явный `.catch` с логированием.
- Таймауты на сетевых и дочерних процессах.

### 0.5 Обработка ошибок

- Пустой `catch {}` допустим только с `logger.*` внутри И комментарием-обоснованием рядом.
- Парсинг JSON из пользовательских/модельных данных — всегда с fallback + логированием
  (никогда молчаливый `{}`).

### 0.6 Порядок и именование

- Порядок: module docstring → импорты (`import type` первыми) → константы → функции/классы.
- lowerCamelCase (функции/переменные), UpperCamelCase (типы/классы), CONSTANT_CASE (модульные
  константы). Без венгерской нотации и `I`-префиксов.

### Файлы этапа

- `docs/agents/code-style.md` (new)
- `AGENTS.md` — строка в таблице Documentation + правило #18 в Key Design Rules + версия.

---

## Этап 1 — Критичные фиксы (4)

TDD на каждый; после — `bun test` + `tsc --noEmit`.

### 1.1 Пустые аргументы tool_call без диагностики

- **Где:** `src/core/agent.ts:842-846`
- **Проблема:** при `JSON.parse` fail аргументы молча становятся `{}`; модель вызывает тул с пустыми
  параметрами и не понимает, почему не сработало.
- **Фикс:** оставить `{}`, но записать warn в session.jsonl (`tool_args_parse_error` + raw-строка,
  обрезанная) и добавить в summaries честный маркер, чтобы модель видела сигнал.
- **Тест:** битый JSON → запись в session-лог + маркер в контексте.
- **Три измерения:** UX — видимый warn; модель — честный сигнал; смежные — контракт session.jsonl
  расширяется аддитивно.

### 1.2 Потеря записи session-лога при битом JSON

- **Где:** `src/core/session-logger.ts:134`
- **Проблема:** `JSON.parse(sanitizeLogMessage(JSON.stringify(call.arguments)))` без try/catch;
  если санитайзер ломает JSON — throw, вся запись `logToolCall` теряется.
- **Фикс:** try/catch → fallback `args: { raw: <sanitized> }` + `logger.warn`.
- **Тест:** sanitized-строка с кавычкой не роняет `logToolCall`.

### 1.3 Мутирование плана в resolveScopeAndRetry

- **Где:** `src/modules/execution/moe-executor.ts:523-524`
- **Проблема:** `subtask.allowed_files = uniq([...])` мутирует объект плана; verifier/re-plan видят
  расширенный scope, которого не было в утверждённом плане.
- **Фикс:** работать с копией (`const scopedSubtask = { ...subtask, allowed_files: _, read_only_files: _ }`),
  передавать копию в `executeSubtask`.
- **Тест:** после approve исходный `subtask.allowed_files` не изменился.

### 1.4 Browser singleton race в MoE

- **Где:** `src/tools/browser.ts:7`
- **Проблема:** module-level `let session`; параллельные волны MoE делят одну Playwright-сессию,
  `close()` от одного субагента убивает сессию остальных.
- **Фикс (минимальный, без смены контракта тулов):** сериализация действий через promise-chain
  (мьютекс); `close()` дожидается текущего действия; `mkdirSync(cookieDir, { recursive: true })`.
- **Примечание:** полная изоляция сессий per-subagent — отдельный MINOR (память Chromium), не в 1.3.1.
- **Тест:** два параллельных `execute()` не пересекаются; cookieDir создаётся.

---

## Этап 2 — Средние фиксы

### 2.1 `sawSecurityBlock` не сбрасывается

- **Где:** `src/core/agent/tool-batch.ts:244-263`
- **Проблема:** флаг никогда не сбрасывается; после любого блока nudge срабатывает на все последующие
  скрипты до конца сессии (ограничен `scriptWorkaroundNudged`, но контекст уже загрязнён).
- **Фикс:** сброс после успешного write_file либо хранить iteration и не учитывать старые блоки.

### 2.2 `costUsd` — кумулятивная стоимость в per-tool событии

- **Где:** `src/core/agent/tool-batch.ts:237`
- **Проблема:** `costUsd: this.deps.costTracker.total` передаётся как стоимость конкретного тула.
- **Фикс:** передавать дельту (`total_after - total_before`); проверить снимки до/после батча.

### 2.3 i18n-байпас в MoE

- **Где:** `src/core/agent-moe.ts:174,181` (и рядом)
- **Проблема:** строки статусов — литералы в обход `t()`.
- **Фикс:** ключи `moe.plan_fallback`, `moe.plan_autofixed` (en+ru).

### 2.4 Слабая типизация MoE

- **Где:** `src/core/agent-moe.ts:28` (`verifyAndMerge: Promise<any>`), `234-236` (duck-typing
  `getUsageByTag`), `104` (cast override).
- **Фикс:** `VerifyMergeResult` как discriminated union; `getUsageByTag?` в `MoEExecutorLike`;
  `orchestratorOverride` типизировать как `MoEOrchestratorLike | undefined`.

### 2.5 Хардкод итерации в stuck detector

- **Где:** `src/modules/execution/moe-executor.ts:156`
- **Фикс:** `stuckDetector.recordIteration(attempt)`.

### 2.6 Sleep без abort-check

- **Где:** `src/modules/execution/moe-executor.ts:265,296`
- **Фикс:** прерываемый `abortableSleep(delay, signal)`; проброс AbortError.

### 2.7 Рост кэша провайдеров

- **Где:** `src/modules/providers/manager.ts:171-186`, `122-125`
- **Фикс:** `resetCache()` при `setModel()` (провайдер всё равно пересобирается с новой моделью) —
  предсказуемее LRU-капа.

### 2.8 Silent catch при инициализации

- **Где:** `src/core/bootstrap.ts:509-511` (ContextLogger), `src/core/agent.ts:1308` (getProviderFor)
- **Фикс:** `logger.warn` с i18n-ключом причины.

### 2.9 Хрупкая vision-детекция

- **Где:** `src/tools/browser.ts:109-112`
- **Фикс:** по возможности через capabilities/`pickFor({vision:true})`; фолбэк — расширенная функция
  с комментарием-эвристикой.

### 2.10 Нет агрегатного капа `input_from`

- **Где:** `src/modules/execution/input-from.ts:36-56`, касты `18-19`
- **Фикс:** общий лимит (`maxChars * 4` либо конфиг `subagent.maxInputSectionChars`), остаток
  помечать `[omitted: budget]`; убрать `as any` через narrowing.

### 2.11 Лишние `(ctx as any).fileOperationsCount` ×5

- **Где:** `edit-file.ts:111`, `write-file.ts:110`, `delete-file.ts:71`, `move-file.ts:101`,
  `create-dir.ts:64` (поле уже есть в `src/tools/types.ts:73`).
- **Фикс:** убрать касты.

### 2.12 Форс-выход SIGINT

- **Где:** `src/cli/repl.ts:507`
- **Фикс:** поднять таймаут до 5000мс (константа + комментарий), перед выходом — warn.

### 2.13 Non-null assertion в session logger

- **Где:** `src/core/session-logger.ts:35`
- **Фикс:** явная проверка `this.session?.` с ранним return.

---

## Этап 3 — Низкий приоритет (при наличии времени / отдельный PATCH)

- `src/i18n/index.ts` — `t()` предупреждает при фолбэке на ключ (только debug-уровень). ✅ Сделано.
- `src/tools/edit-file.ts` — `typeof` guard для `old`/`new`; рассмотреть `replaceAll` (меняет
  LLM-контракт — отдельное решение). ✅ Guard сделан; `replaceAll` отложен.
- `src/tools/bash.ts` — вызывать `resetBashFailureTracking()` при старте новой сессии. ✅ Сделано (сброс по `sessionId`).
- `src/tools/question.ts` — рассмотреть удаление dead code (не регистрируется). ⏭ Отложено (экспортируется, есть тесты).
- `src/migration/backup.ts` — warn при пропуске существующего бэкапа. ✅ Сделано (debug-лог).

---

## Верификация

1. TDD на каждый фикс; тесты рядом с существующими в `tests/`. ✅
2. `bun test` — зелёный; `tsc --noEmit` — чисто. ✅ (2123 pass / 1 skip / 0 fail; typecheck clean)
3. Реальный прогон по `docs/agents/testing.md` из корня репо:
   `bun run mma "<prompt>" --no-agents-md --exit-on-complete -d _testing/<case>`
   (не запускать из песочницы — глобальный `mma` перехватывает прогоны). ✅
   Прогон 1.3.1: `_testing/verify-1.3.1` (LM Studio, `spark-x2.5-4b`) — файл создан и
   прочитан, 2 `tool_call` без `tool_args_parse_error`.
4. Три измерения для каждого фикса. ✅
5. `CHANGELOG.md` — секция `## [1.3.1]`, группировка Fixed. ✅
6. `AGENTS.md` — обновить раздел документации, Key Design Rules, версию. ✅
7. `bun run build:prod` + smoke (`node dist/main.js --version` → 1.3.1). ✅

## Оценка объёма

| Этап | Объём                | Ключевые файлы                                                                 |
| ---- | -------------------- | ------------------------------------------------------------------------------ |
| 0    | 1 doc + правки AGENTS| `docs/agents/code-style.md`, `AGENTS.md`                                       |
| 1    | 4 фикса + тесты      | `agent.ts`, `session-logger.ts`, `moe-executor.ts`, `browser.ts`               |
| 2    | 13 фиксов            | `tool-batch.ts`, `agent-moe.ts`, `manager.ts`, `bootstrap.ts`, `repl.ts`, tools|
| 3    | отложено             | —                                                                              |

## Открытые вопросы

1. Фикс 1.4 — устраивает сериализация действий вместо полной изоляции сессий (полная изоляция — MINOR)?
2. Фикс 2.7 — `resetCache()` при смене модели (выбрано) или LRU-кап?
3. Этап 3 — в этот релиз или отложить?
