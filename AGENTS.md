# MMA v2 — Micro Models Agent

General-purpose AI agent harness for small models (Qwen3.5-9B, 32K-64K context). Complete rewrite from MMA v1. **Not a coding-only agent** — see Positioning below.

> **Design spec:** [docs/specs/2025-07-28-mma-v2-design.md](./docs/specs/2025-07-28-mma-v2-design.md) — architecture, modules, tools, CLI, config, data flow.

> **Literature:** [docs/literature.md](./docs/literature.md) — agent harness engineering best practices audit (Anthropic, OpenAI, LangChain, HuggingFace, deepset, Martin Fowler).

> **UI Style (канонический):** [docs/design/ui/STYLE.md](./docs/design/ui/STYLE.md) — **единственный верный** стиль чат-вывода агента. Мокап: [docs/design/ui/mockup-chat-en-ru.html](./docs/design/ui/mockup-chat-en-ru.html) (EN слева, RU справа). Любой код, конфликтующий со STYLE.md, считается неправильным и подлежит приведению к стилю.

> **Этот файл должен периодически обновляться при изменениях в проекте.** При добавлении новых модулей, тулов, команд, изменении архитектуры или конфигурации — обнови соответствующий раздел ниже. AGENTS.md должен всегда отражать актуальное состояние проекта, чтобы агенты и разработчики имели достоверный контекст.

## Positioning: universal agent, not code-only

**Правило:** MMA — **общий** агент-харнесс для маленьких моделей, а **не** «агент для разработки кода». Пользователь может применять его для чего угодно: разработка, поиск погоды, умный дом, автоматизация, работа с API, настройка компьютера, персональный ассистент, поиск в интернете и любые другие задачи.

Следствие (учитывать при проектировании тулов, промптов, онбординга и UX):

- Формулировки системного промпта, описания тулов и их тултипы **не предполагают**, что задача — про репозиторий с кодом.
- Набор тулов и дефолты не должны быть code-centric; кодовые сценарии (файлы, bash, LSP) — **частный случай**, а не центр.
- Онбординг («Познакомимся») и `init` спрашивают о **профиле использования и домене**, а не только о языке/фреймворке.
- Универсальность и «легкость» важнее узкой оптимизации под программирование.

## Engineering Principles

**Правило (обязательно на каждом этапе):** при **анализе**, **проектировании**, **разработке**, **рефакторинге** и **тестировании** решения всегда учитывай три измерения интеграции:

1. **Реальный пользователь** — как человек (REPL/CLI/`--json`) воспримет поведение: UX, понятность сообщений (`i18n`), предсказуемость, обратимость, отсутствие сюрпризов, читаемый вывод и ошибки.
2. **ИИ-модель** — как маленькая модель (Qwen3.5-9B, 32K-64K) увидит это в контексте: формулировки тулов/промптов, объём и структура tool-output, устранимость ошибок, отсутствие ловушек для слабого reasoning, влияние на бюджет контекста.
3. **Смежные модули и системы** — как изменение сказывается на соседних модулях, провайдерах, сессиях, плагинах, security-модуле, внешних API и контрактах (типы, события, конфиг, `session.jsonl`); не ломает ли оно существующие интеграции и не требует ли синхронного обновления.

Ни одно изменение не считается завершённым, пока эти три аспекта не проверены явно.

## Git & Branching

**Правило (обязательно):** любая задача — фича, фикс, рефакторинг, документация — выполняется в **отдельной ветке**, созданной от актуального `master`. В `master` напрямую не коммитим и не пушим. Имя ветки — `<type>/<краткое-описание>` (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`). Ветка завершается только после ревью и зелёных `bun test` + `tsc --noEmit`; интеграция в `master` — через merge/PR. Дизайн-спека задачи (если есть) коммитится в той же ветке.

## Tech Stack

- **Runtime:** Bun + TypeScript (ES2022, NodeNext module)
- **Testing:** vitest (`bun test`)
- **Linting:** TypeScript strict mode (`tsc --noEmit`)
- **Dependencies:** commander, js-tiktoken, picocolors, execa, jsonrepair, playwright

## Commands

```bash
# Run agent
bun run mma "<prompt>"

# Run agent, machine-readable JSON result (single-run mode)
bun run mma "<prompt>" --json

# Dev mode (watch)
bun run dev

# Build (bundle + copy skills — use this for npm releases)
bun run build:prod

# Test (component tests)
bun test

# Typecheck
tsc --noEmit

# Test a single file
bun test tests/<name>.test.ts

# Session management
bun run mma session list
bun run mma session show <id>
bun run mma session delete <id>
```

> **⚠️ Глобальный mma перехватывает прогоны вне репо.** Запуск `bun run mma` / `mma` из директории без `package.json` проекта (песочницы в `%TEMP%` и т.п.) выполняет **глобально установленный пакет** (старый `dist/`), а не исходники `src/` — правки «не работают». Запускай из корня репо с `-d <песочница>` и сверяй версию в строке `Environment: ... mma <версия>` с `package.json`. Подробнее: [docs/agents/testing.md](./docs/agents/testing.md).

## Documentation

All detailed documentation lives in `docs/agents/`:

| Document                                         | Description                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](./docs/agents/architecture.md) | Architecture, Security Module, LLM Provider Contract, Key Design Rules, Project Structure                               |
| [code-style.md](./docs/agents/code-style.md)    | Code Style Guide: formatting, typing (no `as any`), async/error rules, naming, i18n, gradual tsconfig strictness        |
| [tools.md](./docs/agents/tools.md)               | Question Tool, Browser Tool, Image Handling, Tool Set Narrowing, Process Management                                     |
| [modules.md](./docs/agents/modules.md)           | Session Management, Project Map, UI Rendering, Plugins, Context Budget, Cost Tracking, Auto-Update                      |
| [execution.md](./docs/agents/execution.md)       | Execution Guarantees, Agent Loop States, Orchestrator, RLM-Inspired Features, Hallucination Detection, Migration Safety |
| [testing.md](./docs/agents/testing.md)           | Agent Testing from Console, Small Model Observations, Model Certification                                               |
| [versioning.md](./docs/agents/versioning.md)     | Versioning Rules, Release Process, Version History                                                                      |
| [changelog](./CHANGELOG.md)                      | Public changelog (included in npm package)                                                                              |

## Quick Reference

### Agent Loop States

```
INIT → THINK → ACT → OBSERVE → OUTPUT → ERROR
```

### Context Budget

| contextWindow | System (10%) | Reserve (15%) | History (75%) |
| ------------- | ------------ | ------------- | ------------- |
| 32K           | 3K           | 5K            | 24K           |
| 64K           | 6K           | 10K           | 48K           |
| 128K          | 13K          | 19K           | 96K           |

### Agent-Level MoE (moe.enabled)

Путь: `runWithMoE` (`src/core/agent-moe.ts`) → OrchestratorClient (план) → MoEExecutor → StepVerifier → verifyAndMerge.

- **Re-plan цикл:** `moe.maxReplanCycles` (default 3); каждый re-plan ревалидируется (`plan-validator`);
  битый re-plan → честный partial failure; knownTags — из реестра тулов.
- **Эксперты:** `config.experts` рендерится в PLAN_SYSTEM_PROMPT (`ExpertConfig.description`,
  фолбэк — tool_tags). OrchestratorClient строит provider через ProviderManager
  (entries → per-entry contextWindow/retry/rateLimits, legacy `{type,baseUrl,apiKey}` работает,
  `orchestrator.contextWindow` — глобальный фолбэк).
- **input_from:** результаты зависимых сабтасков инжектятся в промпт (`src/modules/execution/input-from.ts`).
- **scope_request:** rejeceted/approved Router'ом (`src/tools/scope-request.ts`), лимит 2 цикла, default reject.
- **Selective re-plan:** `executePlan(plan, {skipIds, carriedResults})` — успешные сабтаски
  переносятся как carried, переисполняются только упавшие.
- **success_criteria:** машиночитаемые (`file-exists:`, `substring-in-file:`, `command-exit-0:`)
  проверяет StepVerifier до merge; остальные — LLM-only warning.
- **Observability:** события `moe_plan/moe_subtask/moe_replan/moe_verify` пишутся в session.jsonl
  (`SessionLogger.logMoE`), видны в `session show`; usage аккумулируется по expert_tag
  (`MoEExecutor.getUsageByTag`). SessionId реальный (не "moe").
- **Abort:** Esc прерывает MoE без fallback (AbortError летит наверх, очередь сабтасков не стартует).
- **Cert:** тег `moe` — сценарии 5.1-moe-basic, 5.2-moe-parallel-waves, 5.3-moe-read-after-write (timeoutMs 600_000).
- **Test seams:** `orchestratorOverride/executorOverride/verifierOverride` (MoEDeps),
  `AgentDeps.runWithMoEOverride`, `ToolContext.agentFactory` — vi.mock в Bun глобален на процесс, не использовать.

### Instructions Overflow & Context Probe (0.59.0)

- **Overflow:** AGENTS.md (`kind: "instructions"`) и project map (`kind: "project-map"`) — PromptBlock с `kind`
  (`src/core/types.ts`). Если блок не влезает в системный бюджет (10% contextWindow):
  bootstrap dry-run (`dryRunOverflow`) предупреждает юзера с конкретным фиксом
  (`mma context <N>` или правка `provider.entries[].contextWindow` в `config/provider.json`),
  Agent (`resolvePromptOverflowOnce`, до первого LLM-вызова) суммаризирует блок провайдером
  (кэш `<project>/.mma/cache/prompt-summaries`, инвалидируется правкой файла/бюджетом) или
  трекает с маркером; hint-блок (`essential`) говорит модели прочитать полный AGENTS.md через read_file.
  Конфиг: `instructions.summarize` (default true).
- **Context probe:** на старте `getLoadedContextLength` (`src/llm/model-loader.ts`) спрашивает LM Studio
  (`/api/v1/models`, `loaded_instances[].config.context_length`) о фактическом контексте модели;
  меньше настроенного → warn (без auto-clamp), больше → подсказка `mma context`. Не-LM-Studio → тихий null.
  Результат пишется в session.jsonl как `context_probe` entry.

### Prompt Caching & Cache Metrics (0.62.0)

- **Capability:** `ProviderCapabilities.cache` (тип `CacheCapability`, `src/config/types.ts`), дефолты в
  `src/modules/providers/presets.ts`, переопределение на запись — `ProviderEntry.cache`. Резолвер:
  `resolveCacheCapability` (`src/modules/providers/cache.ts`), `ProviderManager.build()` прокидывает в фабрику.
- **Запросные подсказки** (`src/llm/openai-compat.ts`): `cache_prompt` (llama.cpp, off по умолчанию),
  `prompt_cache_key` (OpenAI), `session_id` (OpenRouter sticky), `x-opencode-session` гейтится по `sessionHeader`
  (без capability — легаси-поведение). Ключ — live session id.
- **Парсинг:** `parseCacheUsage` (`src/llm/cache-usage.ts`) → `Chunk.usage.cache` (`CacheUsage`). Форматы:
  `openai` (cached_tokens/cache_write_tokens, покрывает локаль/OpenRouter/Zen/Go), `deepseek`
  (prompt_cache_hit/miss_tokens), `anthropic`, `ollama` (derived). Нет полей → unknown, не «miss».
- **Prefix monitor:** `diffPrompt`/`buildPromptSnapshot` (`src/core/agent/prefix-monitor.ts`) считает
  стабильность префикса и причину (`system`/`tools`/`history`/`volatile`); `llm_usage.cacheStable/cacheCause`.
- **Стоимость:** `ModelPrice.cachedInput/cacheWrite`, `calculateCostDetailed`, `CostTracker.saved`; кеш влияет
  на цену только при `source: "api"`.
- **Показ:** `formatCacheLine` (`src/cli/cache-line.ts`) → REPL/`run-result`/`--json` (`cache`); `session show`
  агрегирует `llm_usage` (токены + hit-rate). i18n: `repl.cache*`, `repl.prefix`, `cache.cause.*`, `cli.session_*`.
- **Бюджет:** `mma usage` (`src/llm/provider-budget.ts`) — баланс только OpenRouter (`/key`, `/credits`); Zen/Go → `unsupported`. Только явный вызов.

### REPL Subcommand Handlers (0.63.0)

- **`/provider add`** (`src/cli/repl-commands.ts`) — добавление провайдера прямо в REPL, зеркало
  `mma provider add`: `/provider add <name> [--url <url>] [--key <key>] [--priority <n>] [--context-window <n>] [--rpm <n>] [--parallel <n>]`.
  Сидит legacy-конфиг в entries, сохраняет, `agent.reconfigure()`. Подсказка переключения — `/provider use <name>`.
- **Правило #17** (`docs/agents/architecture.md`): подкоманды REPL/CLI — через карту хендлеров
  (`Record<string, (args) => void | Promise<void>>`), не через цепочку `if (subcmd === …)`.
  Приведены `provider`/`model`/`skill` и `SkillNameProvider`.
- i18n: `repl.provider_usage` расширен, добавлены `repl.provider_add_missing_value`, `repl.provider_switch_hint`.

### Chat Output Cleanup (0.63.1)

- **`ui.verbose`** (default `false`) — internal MoE status one-liners (plan/re-plan/execute/scope) в `src/core/agent-moe.ts` пишутся в чат только при включённом флаге.
- **Упавшие тулы** — в чат идёт только первая непустая строка ошибки (`compactToolError`, `src/core/agent/tool-output.ts`), а не весь model-facing `result.output` с `Hint:`/recovery-директивами.
- **Спиннеры** — `Renderer` анимирует выполнение тулов (`read_file`/`write_file`/`edit_file`/`bash`/…) и перезапускается на каждой фазе `thinking`; интерактивные (`question`, `approve`) — без спиннера.

### Agent Output Fidelity (0.63.2)

- **Обрезание по completion-лимиту** — `max_tokens` (default 8192) шлётся всегда. Если модель уже стримила текст и упёрлась в `finish_reason: "length"`, провайдер теперь отдаёт non-fatal `warning`-чанк (`src/llm/openai-compat.ts`, стрим + non-stream), а агент рендерит его в чат (не попадает в текст ответа/контекст). Обрыв на tool_call/пустом ответе по-прежнему идёт recoverable-ошибкой. Ключ i18n: `error.llm_output_truncated`.
- **История сессии без обрезки** — `saveAssistantMessage` / `logToolResult` (`src/core/session-logger.ts`) пишут полный контент (раньше `slice(0, 500)`), чтобы `/resume` не терял прошлые ответы и tool-результаты. Бюджет контекста режет то, что уходит в LLM.

### Output Architecture (1.0.0)

- **Single-writer invariant:** единственный владелец терминала — `OutputChannel` (`src/output/channel.ts`); модуль `src/output/machine.ts` — единственный легальный прямой stdout для машинных JSON-контрактов. Продюсеры эмитят `OutputEvent` в `OutputBus`, а не пишут в консоль.
- **Режимы канала:** `idle` (prompt владеет экраном; `log`/`block` → `printAbove`), `streaming` (прямой passthrough, частичная строка закрывается перед `log`), `modal` (очередь FIFO, флаш на `endModal`), `quiet` (`--json`, человеческий вывод дропается). Singleton — `getDefaultChannel()`.
- **Prompt:** `LineEditor.printAbove` печатает блок над полем ввода; `suspendFrame`/`resumeFrame` отдают терминал агенту на время стрима; `setInputEnabled(false)` глотает печатные клавиши, оставляя Ctrl+C. DSR-якорь с таймаутом 150мс и opt-out `MMA_DSR=0`.
- **Sinks:** `JsonOutputSink` (`--json` `diagnostics`, warn/error), `SessionOutputSink` (события с `data.persist === true`). Плагины подписываются через `HostBridge.subscribeOutput`.
- **Guard:** `tests/output/no-direct-console.test.ts` (AST) запрещает `console.*`/`process.*.write` в `src/` и `examples/`; allowlist — crash-handler, machine JSON, browser bridge, non-TTY REPL fallback.

### Streaming & Loop Fixes (1.0.1)

- **Streaming partials** (`src/ui/md-formatter.ts`): `FormattingStream` отслеживает накопленную ширину частичной строки (`streamedChars`/`partialWritten`) и откатывает курсор на всю отображённую ширину перед записью форматированной строки. Частичный стрим — opt-in (`streamPartials`, включает `Renderer` только в rich-TTY; `reservedCols` учитывает префикс `- `). Частичная строка, которая перенеслась бы за ширину терминала, замораживается — относительный `\x1b[ND` при переносе некорректен.
- **Баннер** (`src/cli/repl.ts`): «Директория» = `baseDir` агента (не `process.cwd()`, который `bun run` ставит в корень пакета).
- **Overflow-предупреждения** (`bootstrap.ts`/`agent.ts`, i18n): сообщают суммарную потребность (`~N токенов`), а не сравнение одного блока с общим бюджетом.
- **Interactive-команды** (`src/tools/bash.ts`): `Operation cancelled`/`stdin is not a TTY` → подсказка запустить неинтерактивно.
- **Status-loop** (`src/core/agent.ts`): идентичные `session_info`/`process_list`/`process_log`/`file_info`/`project_map` жёстко останавливаются в интерактиве (`MAX_REPEATED_TOOL_CALLS_INTERACTIVE`); мутирующие тулы — только nudge.
- **Short-response варнинг удалён** (`src/modules/hallucination/confidence.ts`): короткий, но законченный ответ (приветствие, «Готово») больше не помечается как «слишком короткий/пустой». Варнинг не делал ни retry, ни блокировки; реальный обрыв ловится по `finish_reason: "length"`, пустой ответ — retry `emptyResponseRetries`.
- **Первый запуск** (`src/cli/relaunch.ts`, `src/cli/main.ts`): мастер и REPL больше не живут в одном процессе. Raw-mode `LineEditor` на Bun/Windows получает keypress только как первый потребитель stdin, а переиспользование одного редактора через `wizard → bootstrap → REPL` протекало кадром/промптом. Теперь первый запуск: cooked-mode `SetupPrompt` (без raw-mode/readline) → сохранить конфиг → **re-exec тем же CLI новым процессом** (`spawnSync`, `stdio:"inherit"`, guard `MMA_POST_SETUP=1`) → новый процесс видит конфиг, пропускает мастер и создаёт редактор первым. Отдельно: DSR-запрос курсора теперь opt-in на Windows (`MMA_DSR=1`, вне Windows — по умолчанию вкл), т.к. ConPTY декодировал ответ `ESC[row;colR` как ввод (все ответы мастера «R»); в режиме `question()` DSR не шлётся. Числовые ответы валидируются (`NaN` исключён).

### Context Log (1.2.0)

- **Флаг `--context-log`** (плюс конфиг `contextLog.enabled`, env `MMA_CONTEXT_LOG`): пишет весь уходящий в LLM контекст
  (system + tools + history) в `<session>/context.diff` в git-подобном формате. Snapshot 0 — полный контекст (все строки `+`,
  как новый файл), каждый следующий — построчный unified diff (`-`/`+`) к предыдущей итерации. Секции: `[SYSTEM]`, `[TOOLS]`, `[HISTORY]`.
- **Модуль** `src/core/agent/context-log.ts`: `serializeContextForLog` (канонический текст), `unifiedDiff` (plain, без ANSI,
  с common prefix/suffix + LCS, guard `MAX_LCS_CELLS` → fallback full-replace), `ContextLogger` (`record`/`recordOutput`/`close`).
  Секреты редакторятся точечным `redactContextSecrets` (`contextLog.redact`, default true): только опознаваемые токены
  (`sk-`, `ghp_`, `AKIA`, JWT, `Bearer`, `api_key=`/`token=`/`password=`), обычный текст контекста (имена скиллов,
  `pass "background: true"`) не калечится. Общий `sanitizeLogMessage` намеренно НЕ применяется (generic-паттерн 30+ символов вырезал бы легитимный текст).
- **Reasoning** (`reasoningContent`) НЕ входит в контекст LLM — пишется отдельной `[OUTPUT]`-аннотацией (`▍`), в diff не участвует.
- **Файл append-only**: повторный запуск добавляет run-разделитель (`run <pid> · <ts>`) и начинает с полного snapshot, нумерация продолжается.
- **Точка хука** — `Agent.executeSingleAgentLoop` рядом с prefix-monitor (`record` до запроса, `recordOutput` после стрима).
  MoE-путь не логируется. `--context-log` — boolean, значение пути не парсится (pre-parse `valueOpts` не трогаем).

### Agent Hardening from Context-Log Analysis (1.3.0)

Реальный прогон (лендинг/TDD) + разбор `context.diff` выявил баги петли; исправлены обобщённо (без привязки к языку/задаче):

- **Компакция по бюджету** (`contextBudget.compactionMinLoad`, default 0.5): 15-итерационный интервал сам по себе больше не триггерит —
  нужна загрузка истории ≥ порога. Раньше компакция срабатывала на ~40% и теряла 33-44 хода посреди задачи.
- **`context_probe` пишется всегда** (bootstrap) и показывается в one-shot; раньше — только REPL (TODO в `main.ts` закрыт).
- **Churn тест/спек-артефактов** (`src/core/agent/artifact-progress.ts`): серия правок test/spec без production-правок → nudge
  «исправляй код под тестом, а не тест». Классификация путей мультиязычна.
- **Эскалация stuck доходит до модели**: после порога в контекст идёт `<system-summary>` с общими опциями (сменить подход / поиск /
  вопрос / re-plan|skip), а не только UI-баннер.
- **Защита от скриптов-обходов** (`tool-batch.ts`, `bash.ts`): после `[SECURITY BLOCKED]` запись `.bat/.cmd/.sh/.ps1` → nudge;
  подсказка блока указывает на тулы, а не только `workdir`.
- **`plan update` не перезаписывает шаги** (только `re-plan`/`create`); `kinds` валидируется 1:1.
- **Non-streaming fallback при stall после tool_call** (`openai-compat.ts`): буферизованный SSE LM Studio не роняет прогон.
- **Сводка аргументов тулов без тел** (`summarizeToolArgs` сворачивает длинные значения в `…(N chars)`).
- **Артефакт-правило в промпте**: запрошенный документ/артефакт создаётся файлом; неоговорённые библиотеки не добавляются.

### Protected Paths (1.4.0)

- **Always-onguard** (`src/modules/security/protected-paths.ts`): `write_file`/`edit_file`/`delete_file`/`move_file`/`create_dir`
  отказывают на `.git/`, `.hg/`, `.svn/`, `.env*`, `*.key`/`*.pem`/`*.p12`/`*.pfx`/`*.crt`/`*.secret`/`*.token`,
  `.npmrc`/`.netrc`/`.git-credentials`/`.gitconfig` — **независимо** от `security.paths.enabled`. Это soft-guard:
  возвращает директиву «спроси пользователя», не жёсткий блок.
- **Правило `PROTECTED PATHS`** в системном промпте (`buildSystemInfo`): модель не трогает такие пути без явного
  подтверждения и не обходит запрет через `bash`. i18n: `file.protected_path_ask` (en+ru).

### Chat UI Style (canonical) — 1.5.0

**Единственный верный источник стиля чат-вывода — [docs/design/ui/STYLE.md](./docs/design/ui/STYLE.md)**
(мокап: [mockup-chat-en-ru.html](./docs/design/ui/mockup-chat-en-ru.html)). Ключевые правила:

- **Никаких boxed-панелей** — только строки, отступы и глифы. Рамки code-block (`┌─┐`) и
  box-drawing-таблиц (`│─┼`) в чате не рисуются: `md-formatter.ts` (`emitCodeBlock` → `│`-гуттер),
  `src/ui/table.ts` (bold-заголовок + dim-линейка + выровненные колонки). `box()` (`src/ui/box.ts`)
  остаётся **только** для мастера первого запуска (`src/cli/setup.ts`), не для чата агента.
- **Системные имена тулов не показываем никогда** — ни в одной локали. Только `tool.friendly.*`
  («Чтение файла» / «Reading file»). Аргументы (пути, команды, запросы) — это контент, остаются.
  Точка: `Renderer.toolStart` (`src/ui/renderer.ts`).
- **Цвет категории на глифе и ярлыке** (`toolAccent`, `src/ui/theme.ts`): цвет `◇` совпадает с
  цветом текста названия тула; между ярлыком и аргументами, а также между статусом и содержимым —
  dim-разделитель `·`. Иначе глагол размышления (`размышляю`/`прикидываю`) сливается с текстом модели.
- **Quiet by default, детали по запросу** — одна строка на действие, метрики раз за ход; детали за
  `/verbose`, `--verbose`, `Ctrl+O`. Уровни: `quiet | normal | verbose` (расширяет `ui.verbose`).
- **Единый визуальный язык:** один глиф действия `◇`, цвет которого кодирует категорию
  (recon cyan / mutate magenta / execute blue / meta dim — `src/ui/theme.ts`); emoji-иконки тулов
  не рендерятся. Семантические цвета: `✓` зелёный, `⚠` жёлтый, `✗` красный (только реальные сбои),
  `✦` thinking, `↳` деталь, `⟡` метрики, `▰▱` прогресс.
- **Тишина:** quiet скрывает `info`-логи (`OutputChannel.setSuppressInfoLogs`), тела тулов и JSON
  аргументов плана (`plan update` → `step 2 → done`); model-facing recovery-директивы в чат не попадают.
- **Телосложение без шума:** статусы — короткие человеческие фразы; спиннер/прогресс обновляются in place.

Правило проекта: если рендер расходится со STYLE.md — это баг, привести к стилю.

### UI/UX Audit Fixes (1.6.0)

- **Security-paths wizard answer** (`src/cli/setup.ts`, `src/cli/setup-order.ts`): the question was inverted and a no-op; reworded to **restrict** semantics and `security.paths.enabled` is now applied.
- **First-run wizard suppression** (`src/config/config.ts`, `src/cli/main.ts`): `loadConfig` no longer persists a default config on first load (subcommands/one-shots used to create it, so the next interactive `mma` skipped the wizard); a virgin one-shot now **warns** instead of silently using defaults.
- **`/wizard` gaps** (`src/cli/repl-commands.ts`, `src/cli/setup-order.ts`): security answers are applied centrally via `applyAnswersToConfig`, and a multi-entry `provider.entries[]` config updates the active entry instead of being ignored.
- **`mma config show` redaction** (`src/cli/commands.ts`, `src/config/redact.ts`): secrets are redacted by default; `--show-secrets` opts out. `configForDisplay` is the pure, tested helper behind it.
- **Tab completion** (`src/cli/completer.ts`, `src/ui/line-editor.ts`): completions carry descriptions, file-path completion is registered in the REPL, and `↑`/`↓`/Tab cycle candidates with Esc restoring the original partial.

### Model Capabilities & Tool Images (1.7.0)

- **Резолвер возможностей модели** (`src/modules/providers/capabilities.ts`): `resolveModelCapabilities(preset, probe, override)` — единый источник правды `vision`/`tools`. Приоритет: `config.modelCapabilities[model]` (ручной override) → живой native-probe → пресет провайдера. Всегда новый объект.
- **Probe** (`src/llm/model-loader.ts`): `probeModel(baseUrl, model)` читает из LM Studio `/api/v1/models` и контекст (`loaded_instances[].config.context_length` / `max_context_length`), и `capabilities` (`vision`, `trained_for_tool_use`). `getLoadedContextLength` — тонкая проекция для баннера. Не-LM-Studio → `null` (тихо).
- **Тулы видят capabilities** через LIVE-геттер `ToolContext.capabilities` в `bootstrap.ts` (пресет + probe + override пересчитываются на каждое обращение, поэтому `/model use`/`/provider use` видны без пересборки). `modelSupportsVision` (regex по имени) удалён — правило #10.
- **Канал изображений из тулов** (`ToolResult.images` → `queueToolImages` в `src/core/agent/tool-images.ts`): картинки тула встают в pending-очередь контекста и прикрепляются к следующему user-сообщению (обычно к `<system-summary>` в конце batch'а). В `role:"tool"` идёт только текст — base64 туда не пишется (не портируемо + режется бюджетом).
- **Browser screenshot** (`src/tools/browser.ts`): при `ctx.capabilities.vision` возвращает `image_url`-part (ресайз ≤800px через `bufferToDataUrl`), иначе — текстовый snapshot с пометкой. Имя модели больше не влияет.
- Конфиг: `modelCapabilities: Record<string, { vision?, tools? }>` (домен `provider`, `DEFAULTS` → `{}`).

### REPL Commands UX Redesign (2.0.0)

Дизайн: [docs/specs/2026-09-22-repl-commands-ux-design.md](./docs/specs/2026-09-22-repl-commands-ux-design.md).

- **`/config` — единая точка настроек** (`src/config/registry.ts`): ключи = буквальные пути `config.json` (`model`, `provider.active`, `contextWindow`, `contextBudget.systemPrompt`, `showReasoning`, `reasoning.mode`, `ui.verbosity`, …) + короткие алиасы (`context.window`, `context.system`, `reasoning.show`, `reasoning.level`, `verbosity`). `/config <ключ>` читает, `/config <ключ> <значение>` пишет и сохраняет, `/config reset <ключ>`/`--all [--yes]` возвращает к boot-snapshot (значения на старте сессии; `--all` только изменённые). Валидация: enum/bool/int/share (доли принимают `0.1` и `10%`, `system+reserve ≤ 0.95`), read-only `version`, подсказка ближайшего ключа, мягкое предупреждение для неизвестной модели.
- **Профильные команды — чистый сахар** над `setConfigValue` (`repl-commands.mutateConfig`): `/context`, `/verbose`, `/reasoning`, `/model use`, `/provider use`. Один путь записи, один `reconfigure`-контракт (per-key таблица в реестре: `model/provider.active/contextWindow/contextBudget.*/reasoning.mode` → reconfigure; `showReasoning/ui.verbosity/logLevel/locale/maxToolIterations/stuckThreshold` — живьём).
- **Никаких скрытых тогглов**: `/reasoning` и `/verbose` без аргумента — статус (не переключают). `/reasoning show|hide|level <...>` (алиасы `on|off`; уровень печатает «auto policy off»); `/verbose quiet|normal|verbose`.
- **Персистентность единообразна**: любая правка сохраняет `config.json` и печатает `saved · reset: /config reset <key>`. `/config locale ru` перерегистрирует команды и completer (иначе `t()`-описания, вычисленные при регистрации, остались бы на старом языке).
- **`showReasoning` приоритетнее `ui.verbosity=quiet`** (явный показ сильнее ambient-quiet).
- **Экспорт сессии** (`src/modules/session/export.ts`): `/export` и `mma session export` → `md` (default) / `json` / `jsonl`; дефолт `~/.mma/exports/<имя>-<id8>.<ext>`, `--out -` в stdout; секреты редакторятся (`redactContextSecrets`, `--no-redact`); пустая сессия не пишется; повёрнутые `.jsonl.gz` поддержаны.
- **Автокомплит** (`src/cli/completer.ts`): dotted-ключи и enum-значения `/config`, флаги `/provider add`, имена команд для `/help`, имена сессий для `/delete`/`/export`, подкоманды с описаниями (`map/context/lsp/reasoning/verbose`).
- **Унификация**: общий `repl.unknown_sub` + usage у `provider/model/skill/lsp`; `/help <command>` (usage + алиасы + примеры); незнакомые бывшие алиасы (`/use`) → `cli.unknown_command` с подсказкой; `/lsp` переведён на handler-map (правило #17); `/status` — компактная строка; `/sysprompt [--full]`; `/clear` — только экран.

### Current Version: 2.0.0

### Changelog

Все изменения документируются в `CHANGELOG.md` (формат [Keep a Changelog](https://keepachangelog.com/)).

**Правило:** при каждом релизе (MINOR/PATCH) — добавляй запись в `CHANGELOG.md` в секцию `## [X.Y.Z] - YYYY-MM-DD`. Группируй по Added/Fixed/Changed/Removed. Пиши на английском, кратко и по существу. Формат ссылок: `**Module**: description`.

При публикации (`npm publish`) changelog автоматически попадает в пакет и виден пользователям при установке (`npm info micro-models-agent`).

### Commands by Version Bump

**MINOR** — new CLI/REPL commands, new tools, new modules, new config options, new security features

**PATCH** — bug fixes, i18n, docs, tests, performance, non-breaking dependency updates

**MAJOR** — removed/renamed commands, config schema changes, removed tools/modules, architecture rewrites
