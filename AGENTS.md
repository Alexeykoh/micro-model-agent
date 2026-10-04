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

## Agent Tooling Rules (Playwright / фоновые процессы)

- **Playwright — только по явной команде пользователя.** Без его просьбы агент не запускает браузер и не гоняет UI-сценарии сам (медленно + внешние процессы). Подробности и селекторы: [docs/agents/testing.md](./docs/agents/testing.md).
- **Фоновые процессы запускай контролируемо:** `Start-Process` фоном, логи в файл, PID сохранён, readiness-поллинг до `200`, остановка строго по PID (`Stop-Process -Id`). Не держи сессию в «переднем плане» и не убивай процессы пачкой. Не запускай пишущие UI-проверки по реальному `~/.mma` — изолируй через `MMA_CONFIG_DIR`.

## Large files — accepted exceptions (не дробить без явного решения)

Правило ≤300 строк применяется там, где есть чистый шов (так вынесены `core/system-prompt.ts` из
`bootstrap.ts` и `repl-commands-lsp/skills.ts` из `repl-commands.ts`). Следующие файлы **осознанно
оставлены крупными** (решение 2026-09-25): их функции плотно связаны с приватным состоянием класса,
и дробление — риск-рефактор с побайтовой проверкой поведения, а не механический вынос:

- `src/core/agent.ts` — `executeSingleAgentLoop` (~625 строк) держит состояние `Agent`.
- `src/cli/repl.ts`, `src/ui/line-editor.ts` (DSR-протокол), `src/modules/execution/stuck-detector.ts`,
  `src/modules/execution/module.ts`.
- `src/config/registry-extra.ts` (~570 строк), `src/modules/webui/settings-api.ts` (~650 строк) —
  плоские таблицы `ConfigKeyDef`/REST-хендлеров без shared mutable state; нарезка дала бы
  искусственные швы по доменам без выигрыша (решение 2026-09-27, full-config-surfaces).
- `src/modules/webui/turns.ts` (~330 строк) — оркестрация ходов держит связный цикл
  (слоты→сабмит→дренаж) с per-session состоянием (решение 2026-10-01, web-parallel-sessions).
  Бывшее исключение `assets/js/tabs.ts` (~1000 строк) **снято**: в phase 5 он разрезан на
  `assets/js/session/{tabs,composer,sessions-menu,cmdk}.ts` (DI через `init*`), вместе с
  `feed.ts` и `settings.ts` (см. ниже).

## Git & Branching

**Правило (обязательно):** любая задача — фича, фикс, рефакторинг, документация — выполняется в **отдельной ветке**, созданной от актуального `master`. В `master` напрямую не коммитим и не пушим. Имя ветки — `<type>/<краткое-описание>` (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`). Ветка завершается только после ревью и зелёных `bun test` + `tsc --noEmit`; интеграция в `master` — через merge/PR. Дизайн-спека задачи (если есть) коммитится в той же ветке.

## Tech Stack

- **Runtime:** Bun + TypeScript (ES2022, NodeNext module)
- **Testing:** vitest (`bun test`)
- **Linting:** TypeScript strict mode (`tsc --noEmit`) + Biome (`biome.json`; linter only, formatter off — Prettier remains)
- **Quality gate:** `bun run quality` = `typecheck` + `typecheck:frontend` + `lint` + `fallow` (dead-code vs `.fallow-baseline.json`); CI — `.gitea/workflows/quality.yml`; git pre-commit hook — fallow
- **Dependencies:** commander, js-tiktoken, jsonrepair, picocolors, playwright, string-width, yaml (all kept external in the CLI bundle)
- **DevDependencies:** @biomejs/biome, @types/bun, @types/node, @vitest/coverage-v8, esbuild, happy-dom, prettier, typescript, vitest

## Commands

```bash
# Run agent
bun run mma "<prompt>"

# Run agent, machine-readable JSON result (single-run mode)
bun run mma "<prompt>" --json

# Dev mode (watch)
bun run dev

# Web dev mode (watch + live asset reload, no browser auto-open)
bun run web:dev

# E2E web scenarios (isolated MMA_CONFIG_DIR, Playwright; on explicit request only)
bun run test:e2e

# Build (clean + external-deps bundle + frontend + assets + minify — use this for npm releases)
bun run build:prod

# Test (component tests)
bun test

# Typecheck
tsc --noEmit

# Lint (Biome) / full quality gate (typecheck + lint + fallow)
bun run lint
bun run quality

# Test a single file
bun test tests/<name>.test.ts

# Onboarding
bun run mma setup        # provider setup wizard
bun run mma init         # deprecated alias of mma setup (provider wizard)
bun run mma meet         # «Познакомимся» — interview, writes global memory
bun run mma agents init  # generate/improve AGENTS.md for the workspace

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
| [testing.md](./docs/agents/testing.md)           | Agent Testing from Console, Web UI testing via Playwright, Small Model Observations, Model Certification             |
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

### Session ↔ Plan Binding (2.12.0)

Спека: [docs/specs/2026-09-29-session-plan-binding-design.md](./docs/specs/2026-09-29-session-plan-binding-design.md).

- **План следует за сессией:** активный план лежит в per-session слоте
  `.mma/plans/sessions/<sessionId>/active.json` (`PlanStore.save/load/clearSessionActive`;
  id валидируется `^[A-Za-z0-9_-]+$`). Черновики/архив — общая библиотека, как раньше.
- **Трекер переключается явно:** `ExecutionModule.switchSession(id)` (персист уходящей
  стороны + загрузка плана новой; пустая сессия → трекер null) и `forgetSession(id)`
  (чистка слота + сброс трекера, если удаляемая была текущей). `setPlan` пишет и в слот;
  `trackerRef`-сеттер зеркалит слот для план-тулов, пишущих мимо `setPlan`
  (`abort/switch/delete/purge`); `flushSessionPlan` — для внутренних `saveActive`.
- **Точки вызова:** bootstrap (`restorePlan` → `switchSession(active)` — усыновление legacy
  `active.json` стартовой сессией), REPL `/new`/`/resume` (+`/delete` → `forgetSession`,
  `/resume` печатает `◇ <план>`-статус), web `POST /api/sessions|/activate` → `switchSession`,
  `DELETE /api/sessions/:id` → `forgetSession` (коллаборатор `WebUiState.execModule`).
  Фронт после activate/create сразу тянет `/api/state` и перерисовывает сайдбар
  (`renderPlan` + rail), не дожидаясь 2с-полла.

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

### Internal Diagnostics (2.11.0)

- **`Logger.diagnostic(level, msg, meta)`** (`src/logger/app-logger.ts`) — единственная точка для внутренних диагностик петли (hallucination-retry, audit/compaction-инсайды, nudge'и на повторный вызов тула, MoE/critic-внутренности, `LLM warning`). Файловая запись (`<session>/*.log`, `app.jsonl`) не меняется; событие в `OutputBus` получает `data: { diagnostic: true }`.
- **Терминал:** `OutputChannel.setShowDiagnostics(show)` (дефолт `false`) дропает события с `data.diagnostic` ещё в `onEvent`. Флаг включается только при `ui.verbosity === "verbose"`: на старте — `applyLogVisibility()` (`src/cli/main.ts`), в сессии — `/config ui.verbosity` (`repl-commands.ts`); там же правило для `info`-логов (тоже только verbose).
- **Web:** `log-forward.ts` пробрасывает `diagnostic` в SSE `log`; `feed.js onLog` рендерит строку только при `verbosity() === "verbose"`.
- **В чате остаётся только пользовательское**: prompt overflow, `error.provider_build`, `env.killed_processes`, `moe.no_orchestrator`/`moe.plan_failed` — они шлются обычным `logger.warn/info`, а не `diagnostic`.
- **Вердикт критика в чат не рисуется** — `Renderer.criticVerdict` и SSE `critic` удалены (см. Counter-Agent).

### Agent Output Fidelity (0.63.2)

- **Обрезание по completion-лимиту** — `max_tokens` (default 8192) шлётся всегда. Если модель уже стримила текст и упёрлась в `finish_reason: "length"`, провайдер теперь отдаёт non-fatal `warning`-чанк (`src/llm/openai-compat.ts`, стрим + non-stream), а агент рендерит его в чат (не попадает в текст ответа/контекст). Обрыв на tool_call/пустом ответе по-прежнему идёт recoverable-ошибкой. Ключ i18n: `error.llm_output_truncated`.
- **История сессии без обрезки** — `saveAssistantMessage` / `logToolResult` (`src/core/session-logger.ts`) пишут полный контент (раньше `slice(0, 500)`), чтобы `/resume` не терял прошлые ответы и tool-результаты. Бюджет контекста режет то, что уходит в LLM.

### Output Architecture (1.0.0)

- **Single-writer invariant:** единственный владелец терминала — `OutputChannel` (`src/output/channel.ts`); модуль `src/output/machine.ts` — единственный легальный прямой stdout для машинных JSON-контрактов. Продюсеры эмитят `OutputEvent` в `OutputBus`, а не пишут в консоль.
- **Режимы канала:** `idle` (prompt владеет экраном; `log`/`block` → `printAbove`), `streaming` (прямой passthrough, частичная строка закрывается перед `log`), `modal` (очередь FIFO, флаш на `endModal`), `quiet` (`--json`, человеческий вывод дропается). Singleton — `getDefaultChannel()`.
- **Prompt:** `LineEditor.printAbove` печатает блок над полем ввода; `suspendFrame`/`resumeFrame` отдают терминал агенту на время стрима; `setInputEnabled(false)` глотает печатные клавиши, оставляя Ctrl+C. DSR-якорь с таймаутом 150мс и opt-out `MMA_DSR=0`.
- **Sinks:** `JsonOutputSink` (`--json` `diagnostics`, warn/error), `SessionOutputSink` (события с `data.persist === true`). Плагины подписываются через `HostBridge.subscribeOutput`.
- **Guard:** `tests/output/no-direct-console.test.ts` (AST) запрещает `console.*`/`process.*.write` в `src/` и `examples/`; allowlist — crash-handler, machine JSON, browser bridge, non-TTY REPL fallback.
- **Meta kinds:** `onMeta(chunk, kind?)` (`MetaKind = "tool"|"status"|"retract"`, `src/core/types.ts`) — `ToolBatch` помечает `display`/`output`/`diff`/failure-gist как `tool`; web `feed.js onMeta` дропает их в `quiet` (терминальный рендерер гейтит через состояние карточки), статусная мета видна всегда. `retract` — гейт забраковал уже отстримленный черновик: web-форвардер шлёт отдельное SSE `retract`, `feed.js onRetract` убирает черновик из ленты (и из copy-буферов хода) с однострочной пометкой `ui.draft_retracted`; терминальный REPL печатает ту же строку. Отклонения логируются как `claim_retry` (`SessionLogger.logClaimRetry`). `question` возвращает `display: ""`, чтобы model-директивы не эходились в чат.

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

### Provider Context Auto-Detect (2.8.0)
- **Провайдер — первый источник контекста:** `probeProviderContext` (`src/llm/model-loader.ts`) спрашивает
  активный бэкенд о **фактически отдаваемом** окне (загруженный инстанс, не максимум карточки модели):
  LM Studio native (`loaded_instances[].config.context_length` → `max_context_length`) → Ollama native
  (`/api/ps` → `/api/show` `model_info`) → llama.cpp `/props` (`n_ctx`) → OpenAI-compat `/models`-метаданные
  (`context_length`/`context_window`/`max_model_len`/`n_ctx`, incl. OpenRouter `top_provider.context_length`) →
  models.dev-каталог (`src/llm/models-dev.ts`, только для Zen/Go — их собственный `/models` вживую
  возвращает голые id без контекста; `opencode`-секция `api.json` маппится по тем же bare id).
  Голый OpenAI-совместимый `/models` (только id) → `null`, конфиг сохраняется (fail-open).
- **Активная запись, не legacy-плоские поля:** `activeProviderEndpoint` (`src/modules/providers/manager.ts`)
  резолвит `{baseUrl, apiKey, type}` по `provider.active` из `entries` (фолбэк — плоские поля).
  Смена `provider.active` через `setConfigValue` зеркалит плоские поля из активной записи
  (`applyProviderModelMemory`, `src/config/registry.ts`), баннер/`/provider list`/`/reload` читают
  `activeProviderEndpoint` — рассинхрон 2026-09-28 (flat `localhost:1234` при активном `opencode-go`)
  закрыт. Используют: пробник, autoload, reasoning-cache-key (bootstrap),
  identity-сравнение (reconfigure).
- **models.dev-кэш:** slim-проекция (`id → context`) в `~/.mma/models-dev-cache.json`
  (override `MMA_MODELS_DEV_CACHE`), TTL 24h как у reasoning-пробника; stale-кэш используется при офлайне.
- **Применение:** bootstrap (фон, `src/core/bootstrap.ts`) и `Agent.reconfigure` (только при смене
  модели/провайдера, `src/core/agent.ts`) перезаписывают `config.contextWindow` значением провайдера
  (in-memory, в файл не пишется) и пишут `Context probe: auto-set …` в `logSilent`. Смена детектится
  по значению (`Agent.lastProbeIdentity`: все write-пути мутируют живой конфиг in place и передают
  тот же объект — сравнение prev/next ничего бы не увидело). Пробник резолвится
  уже после создания `ContextManager`/провайдера, поэтому `applyProbedContext` (там же) делает поздний
  `agent.reconfigure` — иначе бюджеты остались бы на стартовом окне; скип, если значение переопределено
  вручную или ход уже был (`currentIteration !== 0`). Ручной `mma context <N>` / `/config contextWindow <N>`
  после этого действует до конца сессии. Диагностика пробника — только `logSilent` (контракт
  `tests/core/bootstrap.test.ts`: в консоль/шину не попадает).
- **Живой топбар:** `HostStateSnapshot.contextWindow` (`src/core/host.ts`, `webui/host-state.ts`) +
  `renderState` в `assets/app.ts` подтягивает селектор при расхождении — иначе топбар навсегда показывал
  стартовые 32K.
- **Тесты:** `tests/llm/provider-context-probe.test.ts` (16 кейсов на моке `fetch`),
  `tests/core/bootstrap-probe-apply.test.ts` (late-apply), `tests/providers/active-endpoint.test.ts`.

### LM Studio Provider (2.8.0)

- **Отдельный тип `lmstudio`** (`src/modules/providers/presets.ts`, после `openai-compat` в `BUILTIN_PROVIDERS`):
  тот же OpenAI-совместимый транспорт (`create: openaiCompat`), фиксированный `http://localhost:1234/v1`,
  `requiresKey: false`, `listModels: true`, локальный prompt-cache. Native discovery (`/api/v1/models` —
  загруженный контекст + capabilities) работает через общий пробник по `baseUrl` независимо от типа.
- **Wiring:** оба setup-визарда (скан портов + ключ `not-needed`, `setup.ts`/`setup.js`), web-форма
  (`buildProviderPresets`, подсказки типов в `settings/providers.ts`), CLI (`HOSTED_BASE_URLS` → `mma provider add lmstudio`
  без `--url`). Старый локальный пресет `lmstudio` типа `openai-compat` удалён из `providers-view.ts`
  (существующие записи продолжают работать).
- **Тесты:** `tests/providers.test.ts` (регистрация типа, URL, сборка провайдера), `tests/webui-providers.test.ts`
  (пресет `lmstudio` с новым типом).

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

### Onboarding Commands (2.1.0)

Дизайн: [docs/specs/2026-09-23-onboarding-meet-init-design.md](./docs/specs/2026-09-23-onboarding-meet-init-design.md); план: [docs/plans/2026-09-23-onboarding-meet-init.md](./docs/plans/2026-09-23-onboarding-meet-init.md).

- **`meet` / «Познакомимся»** (`src/modules/onboarding/meet.ts`, `mode.ts`, `prompts.ts`) — LLM-интервью о профиле использования (домен, имя, язык, стиль ответов, привычки, «не делать без спроса»), пишет **только в глобальную память** (`~/.mma/memory/preferences.json`, `facts.md`) через `remember`. REPL-режим: вход по `[Y/n]` после setup, `/meet` (алиас `/познакомимся`) или `mma meet`; выход — по sentinel-тулу `meet_done`. Домен-нейтрально (разработка, умный дом, ассистент, …), 1–3 вопроса за ход, turn cap, `Esc` — выход без записи.
- **`agents init`** (`src/modules/onboarding/init.ts`) — LLM генерирует/улучшает `AGENTS.md` для любого workspace (код, доки, заметки, конфиги): скан через project map/read-only тулы, точечные вопросы, запись в `<baseDir>/AGENTS.md`; существующий файл улучшается **in place** с diff и подтверждением.
- **Строгий allowlist** (`ToolContext.toolAllowlist`, `src/tools/executor.ts`): `meet` — `remember`/`question`/`meet_done`; `init` — `read_file`/`list_dir`/`glob`/`grep`/`project_map`/`question`/`write_file`/`edit_file`. `alwaysOn` и теги allowlist **не обходят**; `meet` не трогает репозиторий.
- **Preflight** (`src/modules/providers/preflight.ts`): `preflightProvider`/`preflightFromConfig` — минимальный chat-запрос (`max_tokens=1`, timeout 3s), гейтит LLM-зависимые входы (`[Y/n]`-оффер, `/meet`, `mma meet`); при недоступности — спокойная подсказка, ничего не пишется.
- **`/memory`** (`src/cli/onboarding-commands.ts`, handler map): overview + `get/set/unset/find/forget`; единая точка просмотра/правки памяти. `mma setup` — мастер провайдера; `mma init` — его устаревший алиас (печатает подсказку `mma setup`); CLI-генерация `AGENTS.md` — `mma agents init`.
- **`question`** (`src/tools/user-input.ts`) приведён к STYLE.md (`?` glyph, отступы, `[N] Свой ответ`, `>` prompt) — глобально для всех тулов, не только `meet`.
- **Observability:** `onboarding_*` события в `session.jsonl` (`SessionLogger.logOnboarding`).

### Full Config Surfaces (2.10.0)

Дизайн: [docs/plans/2026-09-27-full-config-surfaces.md](./docs/plans/2026-09-27-full-config-surfaces.md).

- **`/config` — все ключи** (`src/config/registry.ts` + `registry-extra.ts`): ~110 ключей, типы `string/int/share/bool/enum` + новые `json` (объекты, лимит 20K, `JSON.parse`) и `list` (массивы строк, в REPL — через запятую). `registry.ts` grandfathered (>300 строк) — новые дефы только в `registry-extra.ts`, мердж конкатом в `DEFINITIONS`; `allConfigNames()`/`configDefs()` подхватывают их автоматически (комплитер без правок).
- **`mma config set <key> <value> [--force]`** (`src/cli/commands.ts`): по умолчанию валидация через `setConfigValue` (bad value → `cli.config_invalid`, запись не пишется); `--force` — сырая запись по dotted-пути без валидации (escape hatch для битых конфигов).
- **`/security status` + `/security <key> [value]`** (REPL `repl-commands.ts`, web `commands-settings.ts`, handler-maps по правилу #17): read-only сводка (`security · on/off`, `↳`-строки по STYLE.md, без боксов) + запись отдельных ключей через тот же `setConfigValue`. Web HELP/`/api/commands` подхватывает автоматически.
- **Web settings — IA + generic controls** (`assets/js/settings/controls.ts` → `PANEL_SECTIONS` + `controlFor`: bool→toggle, enum→select, int→number, share→%, list→tag-input, json→textarea с inline-ошибкой). Единственный источник правды: **панель → именованные секции**, имя секции обязано описывать её ключи (никаких бакетов «Дополнительно» с чужими ключами). 14 разделов меню (general/model/context/reasoning/agent/network/browser/sessions/ui/memory/skills/plugins/security/advanced); внутри — карточки-секции с заголовком и однострочным пояснением (`sec-title`/`sec-desc`). Счётчиков в меню нет. Панели с кастомным телом (model/ui/memory/skills/plugins/security) рендерят его первым и добирают секции из таблицы. Тесты-сторожа: каждый ключ реестра ровно в одной секции, у каждой секции есть en+ru подпись.
- **Settings search** (`settings/search.ts`): индекс строится из той же `PANEL_SECTIONS` + i18n-подписей, поэтому поиск не может разойтись с раскладкой. Результат = подпись + панель + dotted-ключ; выбор переключает панель и подсвечивает строку (`.row-flash`). Меню скрывается за результатами, `Esc` очищает.
- **Структурные редакторы** (`registry-extra.ts` → `ConfigKeyDef.editor`, рендер в `settings/controls.ts`): UI-подсказка, как показывать `list`/`json`, не меняя сам ключ. `kind: "tags"` — чипсы с ✕ и полем добавления (bash/paths/network-списки, `tools.defaultTags`, `dangerousPatterns`); `kind: "checkboxes"` — мультивыбор из фиксированного набора (`auditNotifier.eventTypes`); `kind: "table"` — строки-записи с типизированными колонками (`pricing.overrides`, `experts`, `modelCapabilities`; `columns[].array` = колонка-список, `optional` = можно не заполнять). Таблица валидирует запись на клиенте и **не** постит неполную строку. Редакторы постят JSON-строку; `parseConfigValue` для `list` принимает и JSON-массив, и запятые (значения с запятыми, например `a{1,3}`, больше не ломаются). Метаданные отдаются веб-UI в `GET /api/config` (`registry[].editor`).
- **Один вложенный диалог** (`#subOverlay`/`openSubDialog` в `settings/modal.ts`): правка провайдера, MCP-сервера, LSP-сервера **и добавление записи памяти** открывается поверх настроек (не inline), с focus-trap, возвратом фокуса и закрытием по Esc/фону. `hideProviderOverlay`/inline-формы удалены.
- **Provider form** (`providers-api.ts`): `maxCompletionTokens` (512–128000), `cache` (mechanism/report selects + 6 bool-флагов), `retry{maxRetries,baseDelay,maxDelay}`; зеркалится в legacy при active. Ошибка валидации — существующий `400 invalid-provider`.
- **MCP CRUD + LSP read/edit** (web, `settings-api.ts`, таблица `API_ROUTES`): `POST /api/mcp` (create) + `PUT /api/mcp/:id` (full edit, `stdio→command` / `sse|http→url` обязательны), `GET /api/lsp` + `PUT /api/lsp/:lang` (только `enabled/timeout/command/args`; add/remove серверов — JSON вручную, бинарники host-specific). Всё с `restartRequired: true` (эффект со следующего запуска), персист через общий `persistAndReconfigure`.

### Browser Mode (`mma web`) (2.2.0, Phase 3 — 2.4.0)

Дизайн: [docs/specs/2026-09-23-mma-web/design.md](./docs/specs/2026-09-23-mma-web/design.md).

- **`mma web [--port N] [--host H] [--token T] [--no-open]`** — браузерный чат **без TTY**: тот же `bootstrap()`/`Agent`/сессии, вторая реализация `Host` (`WebHost`, `src/core/web-host.ts`) поверх `src/modules/webui/`. Терминальный REPL не меняется; терминал и веб — отдельные процессы.
- **Env:** `MMA_WEBUI_PORT` (default random), `MMA_WEBUI_HOST` (`127.0.0.1`), `MMA_WEBUI_TOKEN`, `MMA_WEBUI_OPEN=0`, `MMA_WEBUI_MAX_CLIENTS`.
- **Transport:** SSE `GET /events` (`state, text, meta, reasoning, phase, tool_start, tool_end, turn_end, plan, command, error, log, retract, index`); REST `GET/POST /api/config`, `GET /api/models`, `GET /api/state`, `POST /api/message`, `POST /api/interrupt`, `POST /api/command`, `POST /api/answer`, `GET /api/i18n`, `GET/POST /api/sessions`, `POST /api/sessions/activate`, `DELETE /api/sessions/:id`, `GET /api/sessions/:id/history`, `GET /api/sessions/:id/log`, `GET/POST /api/memory`, `DELETE /api/memory/:category/:n`, `GET /api/skills`, `GET /api/plugins`, `GET /api/file?path=` (просмотр файла из карточки, ответы `text/plain`); static `/`, `/app.js`, `/styles.css`. Auth: loopback по умолчанию, non-loopback требует токен; same-origin на запись; caps на body/клиентов. GET-навигации (клик по карточке) аутентифицируются HttpOnly `SameSite=Strict` cookie `mma_web_auth`, которую сервер ставит на любой успешный запрос, — токен в URL ссылки не попадает.
- **UI:** паритет с каноническим мокапом — topbar (new chat/sessions/tabs/settings), feed с карточками (plan/file/link/image), reasoning-тоггл, селекторы model/provider/context, сворачиваемый сайдбар, settings-модалка (General/Model/Context/Reasoning/UI/Memory/Skills/Plugins·MCP/Security/Advanced), тема dark/light/auto, вложения изображений, создание сессии.
- **Композер:** attach + textarea + send — единая bordered-поверхность поля (контролы внутри, focus-ring на группе); send (`arrow-up`) на время хода становится stop (`square`); textarea авто-растёт (≤200px); чипы селекторов с Lucide-шевронами; хинт `Esc` — только во время хода.
- **Per-tab ввод + настоящий параллелизм:** черновик текста и аттачи живут на табе (`tab.draft/tab.attachments`, save/restore в `openTab/closeTab`), `#inp` один на браузер, но ощущается своим. `POST /api/message|command|interrupt` несут `sessionId` вкладки-отправителя. Каждая сессия ходит СВОИМ раннером (`RunPool` в `session-pool.ts`, фабрика `createSessionRunnerFactory` в `core/bootstrap/session-runner.ts` + скоуп в `session-runner-scope.ts`: свой `Agent` + `ContextManager` + запиненный `SessionManager.forkPinned` + `ExecutionModule` + `ToolExecutor`/`ToolContext`/реестр поверх shared провайдера/стора/памяти) — слоты бегут параллельно, в пределах сессии single-flight + FIFO (`queued`, кап `MAX_QUEUE_LENGTH`). Оркестрация ходов — `turns.ts`, статусы — `session-status.ts`, POST-действия — `actions-api.ts`, reconfigure — `reconfigure.ts`. События SSE тегируются владельцем (per-run форвардер), вопросы — тоже (`createWebPromptIO(state, sessionId)`, scoped cancel); interrupt scoped (`shutdown(sessionId)` + kill только своих процессов). Web **всегда** идёт через per-session раннер: legacy-путь однo-сессионного main-агента удалён (`turns.ts` без `hasFactory()`-ветвлений, `drainQueueTurn`/`submitLegacy` убраны; без сессии/фабрики — `503 no_session`/`no_runner`), `Host.submit` в web не поддерживается. SSE доставляется **всем клиентам** (одно окно = много вкладок, фоновая должна стримиться живьём); раскладка по вкладкам — на клиенте (`feedForEvent` по `sessionId`). Сессии делят workspace (worktree-изоляции нет — как два терминала в одном каталоге). Табы несут бейдж `idle|working|waiting|queued|failed` (точка `.dot`, `setTabStatus/reconcileTabStatuses` в `tabs.js`, own-листенеры SSE в `app.js`, титулы `web.tab.*`, `runningSessionIds[]` в `/api/state`/SSE `state`); завершение в чужой вкладке фокус не крадёт.
- **Chrome-иконки:** инлайн SVG [Lucide](https://lucide.dev) (MIT) в `app.js` (`icon()`/`ICONS`, zero-dep) вместо emoji/`⚙`; чат-глифы (`◇ ✓ ✗ ✦ ⟡ …`) остаются текстовыми по STYLE.md.
- **A11y:** реальные `<button>`/`role="switch"`/`role="tab"`+`tablist`/`role="log"`, `aria-*`, `:focus-visible`, arrow-key в settings-табах, Tab-ловушка в модалке, `prefers-reduced-motion`; клавиатурные `qopt`/`toggle`/меню.
- **Сайдбар:** usage-ячейка `probe` берётся из LM Studio context-probe (`contextProbe` в `HostStateSnapshot`); plan/usage не перерисовываются при неизменном `/api/state` (иначе 2s-поллинг сбрасывал скролл).
- **Секция «Окружение»:** в сайдбаре — рабочая директория, источники AGENTS.md (проект/`.mma`/глобальный; `disabled` при `--no-agents-md`) и размер карты (`projectMap`: файлы·символы·токены). Данные — в `HostStateSnapshot` (`workspace`/`instructions`/`projectMap`), заполняются `buildHostState` из `WebUiDeps` (`baseDir`/`agentsMd`/`indexer`); `agentsMdPaths` в `core/bootstrap.ts`, `IndexerModule.stats()` (кэш на индекс). Те же три строки добавлены в `/status`.
- **Маршрутизация SSE:** `broadcast` (`state.ts`) добавляет `activeSessionId` в каждый event; клиент кладёт стрим в вкладку своей сессии, а не в активную.
- **Slash-команды в браузере:** `/help` `/status` `/config` `/model` `/provider` `/memory` `/reasoning` `/verbose` `/context` `/session list|use` `/export` (handler map); `/clear` и `/new` — клиентские; terminal-only команды вне scope.
- **Автокомплит команд:** ввод `/` в поле открывает список (источник — `GET /api/commands`, единый с `/help`); `↑/↓` — навигация, `Tab` — подстановка, `Enter` — подстановка выбранной (или отправка точной команды), `Esc` — закрыть. Ярлыки тулов локализованы через `tool.friendly.*`; id сессии в списке/вкладках — полный (`<sid>`); `RU`-плюрализация счётчиков — `pluralCount` (`*_one/_few/_many`).
- **Вопросы:** в web-режиме `question`/`approve` зарегистрированы и используют web-`PromptIO` (SSE `question` + `POST /api/answer`); в терминале остаются выключены. Мультивыбор (подсказка + send) и «own answer…» (`CUSTOM_INDEX = -1` → follow-up free-text) поддержаны.
- **i18n:** `GET /api/i18n` отдаёт словари, chrome веб-UI локализуется и переключается при смене `locale`; SSE-reconnect с ресинком; статика с `Cache-Control: no-store`.
- **Настройки:** адаптивная модалка; локализованные подписи конфига (`config.key.*`) и enum (`config.enum.*`); read-only `version`; Security-тумблеры (`security.enabled/paths.enabled/contentScan.enabled/sessionEncryption.enabled`) + маскированный web-токен; провайдеры `GET/POST /api/providers` + `DELETE /api/providers/:name`; MCP `POST /api/mcp/:id` (применяется со следующего запуска); плагины — read-only (enable/disable через файлы).
- **Панель «Модель и провайдер» (2.7.0):** две секции `.settings-section` — «Модель» (поиск + скроллируемый `.model-list`, активная выделена) и «Провайдеры» (кнопка `.sec-add` в шапке секции, строка `.provider-item` с бейджем `[активный]`, dim-строкой метаданных и чипсами `make active`/`edit`/`delete`). Дублирующей строки «активный провайдер» нет. Форма добавления/правки (`providerForm`) открывается **inline** в секции (без новых модалок), обязательные поля сверху, опциональные (context/priority/rpm/parallel) — в `<details> «дополнительно»`; `datalist` подсказывает типы провайдеров и base URL. Спек: `docs/specs/2026-09-25-webui-provider-settings-design.md`.
- **Multi-provider (2.7.0):** `provider.models[name]` помнит последнюю модель каждого провайдера (`setConfigValue` в `src/config/registry.ts`): `model` → запись под активным, `provider.active` → восстановление; веб `postConfig` после смены провайдера/модели перечитывает `/api/config` + `/api/models`. Имена провайдеров уникальны (`providerNameTaken`, `src/modules/providers/naming.ts`): коллизия label/type → `409 name-conflict` в web и `cli.provider_name_conflict` в CLI; правка из web шлёт `originalName`, поэтому запись может сохранить своё имя. Удаление активного по-прежнему запрещено (`active-provider`) — сначала переключись.
- **Пресеты провайдеров в форме (2.7.0):** `GET /api/providers` отдаёт `presets` (`buildProviderPresets`): `BUILTIN_PROVIDERS` с фиксированными `baseUrl` + именованные локальные (**LM Studio / Ollama / vLLM** → `openai-compat` с известными URL). В форме `providerForm` селект «шаблон» одним кликом заполняет `type`/`name`/`baseUrl` — ни хостед, ни локальный провайдер не требуют вводить URL руками (`web.settings.provider_preset/provider_custom`).
- **Activity rail (над композером, unreleased):** индикатор занятости агента (`js/rail.js`, leaf-модуль, подписан на свои слушатели SSE в `app.js` + `setBusy` в `reflectBusy`): живёт весь `busy`-период (in-feed `.busy` гаснет на первом `text`), без плана — indeterminate-сканер + вспышка на каждое `tool_*`/`text`/`plan`, с планом MoE — честный `done/total` и засечки шагов; фаза (thinking/tool/composing), таймер, счётчики тулов/событий, последний тул (`labelOf` из `format.js`). Раскладки `ui.activityRail` = `off|line`(default)|`meta|full` (меняются live в Settings → Chat output и через `/config`); спека: [docs/specs/2026-09-27-activity-rail-design.md](./docs/specs/2026-09-27-activity-rail-design.md).
- **Chat motion + sticky autoscroll (unreleased, ветка `fix/web-autoscroll`):** только opacity/transform, 100–200мс, всё гаснет под `prefers-reduced-motion` (существующий kill-switch в `styles.css`). Новое: entrance `rise` строк ленты (`.feed > *`), `▌`-каретка стрима (`.md.streaming::after` + имеющийся `blink`), пульс живых ярлыков (`.busy .lab`, `.think.live .think-h .lab`, `.rail-l1 .lab`, `.act.running .lab` — `live` снимает `finishThink`, `running` снимает `onToolEnd`/`onTurnEnd`, иначе «думаю» выглядит зависшим после хода), `pop` меню/диалогов, hover-переходы, `fade` сворачивания quiet-ран (`fold-out` + 160мс перед `remove`), edge-fades транскрипта (классы `scrolled/unfollowed` из скролл-хука), пилюля «↓ к новому» (`web.scroll.latest`, en+ru). Скролл липкий: флаг `follow` (`feed.js`) — у края пинимся на каждый аппенд, при уходе вверх не дёргаем; форс-пин на отправке/открытии таба/загрузке истории (`scrollToBottom`, экспорт в `tabs.js`); спиннер `showBusy` задержан на 180мс и не вспыхивает поверх стартовавшего стрима.
- **Связь с `examples/plugins/web-ui`:** плагин остаётся примером, `mma web` — first-class core-режим.
- **Структура после рефакторинга 2026-09-26:** backend — `body.ts` (`parseJsonBody`/`readJsonBody`, единый парсинг POST), `persist.ts` (`persistAndReconfigure`), `server.ts` — таблица `API_ROUTES` + `API_GROUPS` (правило #17), `host-state.ts` (снапшот/usage/plan), `run-agent.ts` (турн-раннер), `model-cache.ts`, `providers-view.ts` (read-модели); каждый файл ≤300 строк, `maxClients` живёт в `createWebUiState()`. Фронтенд — ES-модули `assets/js/` (с 2.17.1 на TS): `app.ts` (~240: boot/SSE/renderState) + `dom`/`api`/`i18n`/`store`/`format`/`feed`/`tabs`/`settings`/`dialog`; сервер отдаёт `/js/*` (`jsModules`, live-reload как остальная статика). DAG ацикличен: app → settings → tabs → {feed, dialog}; связь локали — хук `hooks.applyStaticI18n`. Дедуп: `planStepMark`, `makeToggle` (dom), `trapTab` (dialog), очередь тостов в `setIndicator`, `web.command.*` i18n для `/help`+`/api/commands`. План: [docs/plans/2026-09-26-webui-decompose.md](./docs/plans/2026-09-26-webui-decompose.md).
- **E2E-покрытие фич** (`tests/e2e/`, `bun run test:e2e`, только по явной команде): `web-helpers.ts` + `web-commands`/`web-chat-tabs`/`web-settings` — все 13 slash-команд, чат (успех и чистая ошибка без LLM), табы/сессии/confirm, аттачи, file viewer, 11 панелей, тема, локаль, память, MCP; файлы гоняются последовательно (`maxWorkers: 1` в `vitest.e2e.config.ts`). Найденный там баг: web `/config locale` теперь применяет `setLocale` (`commands-shared.ts`, как REST).

### Web First-Run Setup (2.6.0)

Дизайн: [docs/specs/2026-09-25-web-first-run-design.md](./docs/specs/2026-09-25-web-first-run-design.md).

- **Общее ядро setup** (`src/modules/setup/`): `answers.ts` (`SetupAnswers`, `SETUP_LANGUAGES`,
  `SETUP_DEFAULTS`, `buildSetupDisplay()`), `apply.ts` (`applyAnswersToConfig` + `SECURITY_BASH_BLOCKLIST`),
  `discovery.ts` (`scanLocalServers`/`fetchProviderModels`/`testProviderChat`). Терминальные пути —
  тонкие shim'ы: `src/cli/setup-order.ts` реэкспортирует `apply.ts`, `src/cli/setup.ts` берёт типы/дефолты/
  discovery оттуда. Один контракт записи для обоих фронтендов; тесты `tests/cli/main-first-run.test.ts` не менялись.
- **Сервер** (`src/modules/webui/setup-api.ts`): `GET /api/setup` (`required` + languages/providers/defaults),
  `POST /api/setup/{scan,models,test,locale}`, `POST /api/setup` (валидация → `applyAnswersToConfig` →
  `setLocale` → `saveConfig` → `reconfigure` → `state.setupRequired=false` → SSE `setup_done`). Контракт:
  `400 invalid-answers`, `409 already_configured` (повторный вызов после настройки), `503 config_unavailable`.
  API-ключ принимается, но **никогда не возвращается**.
- **Гейтинг (defense in depth):** `state.setupRequired` (из `virgin` в `web-command.ts`) — чат-эндпоинты
  `POST /api/message` и `POST /api/command` отвечают `409 setup_required`; разрешены `/events`, статика,
  `/api/state`, `/api/i18n`, `/api/setup*`. Реализовано в `util.ts` (`handleMessagePost`) и `server.ts`
  (`/api/command`), чтобы curl/вторая вкладка не обошли UI.
- **Фронтенд** (`assets/setup.ts`, `index.html`, `app.js`, `styles.css`): скрытый полноэкранный `#setupGate`,
  `window.MmaSetup.maybeOpen()` (Promise<boolean>) вызывается первым в `app.js` `boot()`; при `required`
  визард (Language → Provider → Key → Model → Context → Security → Review) берёт экран (`body.setup-active`)
  и после успеха делает `location.reload()`. Локализация `web.setup.*` (en+ru, RU-плюрализация `_few`),
  стиль по `docs/design/ui/STYLE.md` (строки/глифы, без boxed-панелей). `/setup.js` отдаётся как статик
  (`WebUiAssets.setupJs`, `Cache-Control: no-store`).
- **Проверка подключения и контекста:** шаг Provider имеет кнопку «Проверить подключение» (`POST
  /api/setup/models` — достижим ли `/models`), шаг Context — «Определить у провайдера»
  (`POST /api/setup/context` → `probeProviderContext`, подставляет реальное окно; fail-open).
- **Тонкая настройка безопасности из поп-апов:** каждая опция шага Security (paths/bash/flags) и
  «Расширенные настройки» открывают модалку (`#setupOverlay`-подобный `.setup-overlay`, `openSecurityPopup`)
  с полями группы (списки — textarea «по одному в строке», булы — чекбоксы, числа/enum). Данные —
  `SetupSecurityDetail` (`answers.ts`), снепшот живого конфига отдаётся в `GET /api/setup`
  (`securityDetailFromConfig`, без `contentScan.dangerousPatterns` — RegExp не сериализуется). `POST
  /api/setup` валидирует (`parseSecurityDetail`: типы, трим, лимит 200×200) и `applySecurityDetail`
  переопределяет указанные поля поверх логики трёх тумблеров. Правила/списки попадают и в системный промпт (Protected Paths).

### Web Markdown, Highlighting & Copy (2.7.0)

- **Рендерер:** `src/modules/webui/assets/md.ts` (ESM) поверх вендоренного `smd.js`
  (streaming-markdown, MIT). `mountMarkdown(parent, opts)` стримит чанки, `renderMarkdown(parent, text, opts)`
  рендерит готовый текст (история). Инкрементально — только append в DOM, без полного ре-рендера (старый `parseFences`/`renderTextSegment` удалён).
  Half-open inline (`**bo`) достраивается без мерцания. `app.ts` — ES-модуль, импортит `./md.ts`.
- **Безопасность:** текст только `createTextNode`; `innerHTML` не используется. HTML от highlight.js парсится
  через `DOMParser` (инертный) и импортируется узлами. URL — allowlist `http(s):`/`mailto:`/`data:image`; `javascript:` отбрасывается; ссылки получают `target=_blank` + `rel=noopener noreferrer`.
- **Подсветка:** вендоренный `hljs.js` (highlight.js common, MIT, `window.hljs`). Подсветка — **один раз при
  закрытии fence** (не на каждый токен); палитра `.hljs-*` в `styles.css` на семантических токенах темы (dark/light).
- **Кодовый блок:** `.codeblock` с dim-шапкой `.cb-head` (lowercase язык `.cb-lang` + кнопка `.cb-copy`).
  Копирование — `copyText` (`navigator.clipboard` → fallback `execCommand`), кнопка активна только после
  закрытия блока, успех — `✓`.
- **Копирование сообщения:** `app.js` добавляет строку `.msg-actions` (`copy` / `copy as markdown`) в конце
  ассистентского хода и после каждой assistant-записи в истории; plain-текст берётся из DOM, markdown — из
  накопленного сырого текста. Ключи i18n: `web.code.copy/copied/copy_failed`, `web.msg.copy/copy_md` (en+ru).
- **Ассеты/роуты:** `WebUiAssets.mdJs/smdJs/hljsJs`, `STATIC_ASSETS["/md.js"|"/smd.js"|"/hljs.js"]`;
  `index.html` грузит `hljs.js` (defer) и `app.js` как `type="module"`. `build:prod` копирует их автоматически.

### Web Sidebar Tabs (2.13.0)

- **Tab bar** (`src/modules/webui/assets/js/sidebar.ts`, `index.html`, `styles.css`):
  квадратные Lucide-иконочные вкладки **Session / Map / Trace** сверху сайдбара; имя активной
  вкладки показано строкой ниже вкладок. Дефолт — Session; последняя вкладка помнится в
  `localStorage["mma-sidebar-tab"]`; хоткеи `Alt+1/2/3`; вкладка и панель Trace скрыты на ≤760px.
- **Session** — существующие секции plan / session·usage / environment без изменений.
- **Map** (`ProjectMapInfo`: status, `updatedAt`, watcher, files/symbols/tokens, root, top-8 языков)
  рендерится `assets/js/sidebar.ts`; кнопка **Re-index** шлёт `POST /api/index`
  (новый роут → `WebUiState.refreshIndex` → `broadcast` события `state` по завершении).
  Вотчер карты (`watch`/`unwatch`) в вебе поднимает сам веб-хост (`attachIndexWatcher`,
  `src/modules/webui/index-watcher.ts`) на старте `startWebUi` и снимает в `stop()`: в web
  сессия главного агента не гоняется, поэтому REPL-хук `onSessionStart` индексатора не срабатывает.
- **Trace** — живой per-session буфер (cap 500, DOM ограничен, одна строка на вызов тула,
  текстовый стрим сворачивается в одну обновляемую строку, полный текст — в деталях,
  cap 20K); master-detail
  (`.sb.sb-expanded` → 680px + панель `.trc-detail` с метаданными/аргументами/выводом).
  Живые строки: tool/phase/plan/question/text/error + status (SSE `meta`), log (SSE `log`,
  кроме info-diagnostic), retract, index (SSE `index` start/done/error из `refreshIndex`).
  Диагностика без новых продюсеров: `GET /api/sessions/:id/log` (`log-api.ts`, фильтр
  `?types=&since=&limit=`, whitelist полей, скраб) — Trace докачивает critic/MoE/compaction/
  probe/usage/audit/claim_retry/output инкрементом на каждый `turn_end`; деталь текста
  сверяется с логом (число assistant-сообщений, итерации, модель/токены). `turn_end` несёт
  серверный `turnSeq` (`WebUiState.turnSeq`). Git-операции отдельным событием не выделяются
  (тонут в `bash`, эвристика по префиксу хрупкая) — команда видна в строке тула.
- **Backend:** `ProjectMapInfo`/`ProjectMapLanguage` в `src/core/host.ts`; `IndexerModule.mapInfo()`
  + `builtAt` в кэше индекса; `WebIndexer.mapInfo?/refresh?/watch?/unwatch?`; `attachIndexWatcher`
  (`src/modules/webui/index-watcher.ts`, вотчер на время жизни web-хоста); `POST /api/index`.
- **Тесты:** `tests/indexer-module.test.ts`, `tests/modules/indexer/cache.test.ts`,
  `tests/webui-usage.test.ts`, `tests/webui-server.test.ts`, `tests/webui-assets.test.ts`, `tests/i18n.test.ts`,
  `tests/webui-index-watcher.test.ts`, `tests/webui-log.test.ts` (хвост лога + `turnSeq`),
  e2e `web-boot` (Trace-панель + жизненный цикл индекса).

### Session Auto-Naming (2.6.0)

- **Детерминированно + LLM:** имя сессии выводится из первого user-сообщения
  (`deriveSessionName`, `src/modules/session/auto-name.ts`) в единственном хуке `Agent.run()`
  (REPL/web/one-shot), затем fire-and-forget LLM-уточнение (`generateSessionTitle`, timeout 8s,
  fail-open) при `config.session.autoName` (default true).
- **Provenance:** `SessionMeta.nameSource` (`default`/`auto`/`manual`); ручное имя (`create(name)`
  или `rename`) никогда не перезаписывается. Web-таб обновляет подпись из SSE `state.sessionName`.

### Counter-Agent (In-Loop Critic) (2.6.0)

- **Модули:** `src/modules/critic/` (`types.ts`, `evidence.ts` — `buildEvidencePack`/`isWorkMutation`,
  `client.ts` — `CriticClient`/`parseVerdict`/`CRITIC_SYSTEM_PROMPT`, `provider.ts` — `buildCriticProvider`,
  `tools.ts` — read-only verification loop) + `src/core/agent/critic-gate.ts`
  (`CriticGate`, `gatherTurnToolEvents`). Встроен в `executeSingleAgentLoop` рядом с `AuditGate`/
  `HallucinationGate`; **MoE-путь не тронут**.
- **Поведение:** единственная точка вызова — перед принятием финального ответа
  (`beforeFinish`, `agent.ts`); mid-turn ветки нет. Evidence скоупится текущим заходом
  (`LoopState.criticHistoryMark` + `gatherTurnToolEvents(cm, mark)` — тулы прошлых
  вопросов в пакет не входят). Чистый чат (нет тул-событий захода) — `pass` без
  LLM-вызова, бюджет не тратится. `critical` в пределах `critic.maxRepairCycles` →
  repair + retry (один раз); `concern`, `critical` сверх бюджета и near-identical
  повтор (`critic.repeat`, нормализация регистра/пунктуации) → инжект
  `<system-summary>` + `pass` без retry. Дедуп по `severity:claim` (+ нормализованный
  вариант в том же наборе). Жёсткий лимит `critic.maxCalls` за прогон.
  Fail-open (null/timeout/битый JSON/throw ⇒ `pass`).
- **Что видит критик:** `task/planSummary/toolDigest/changedFiles/commands/fileExcerpts`
  + `answerExcerpt` (выдержка финального ответа ≤2000 символов, redact секретов —
  только для ходов без work-мутаций; при мутациях судья — файлы/команды).
  Систем-промпт: чат-доставка без файлов — не issue. `exitCode` успеха не синтезируется
  (`undefined` → рендер `?`; `1` только при известном фейле).
- **Конфиг:** `critic.{enabled,model,provider,tools,maxCalls,maxRepairCycles,timeoutMs}`
  (дефолты `true`/unset/unset/`true`/`4`/`1`/`15000`); доступны в `/config` и web settings (Advanced),
  вместе с `moe.enabled`/`moe.maxReplanCycles`.
- **Observability:** события `critic_check` (вызов)/`critic_verdict`/`critic_escalation` в `session.jsonl`
  (`SessionLogger.logCritic`) + диагностическая строка `Logger.diagnostic("info", …)` — видна в терминале/web
  только при `ui.verbosity === "verbose"`. **В чат вердикт не рисуется:** `Renderer.criticVerdict`,
  SSE `critic`, UI-колбэк `onCritic` и ключи i18n `ui.critic_*`/`web.critic_*` удалены;
  model-facing repair/advice (`<system-summary>`) в чат не попадает.
- **Phase 2:** выделенный critic-провайдер (`critic.provider`/`critic.model` через `ProviderManager`,
  `src/modules/critic/provider.ts`; без `model` — активный провайдер, битый оверрайд — warn + fallback)
  и ограниченный read-only tool-loop (`critic.tools`, default true): после concern/critical критик может
  запросить до 3 проверок (`read_file`/`grep`/`glob`/`file_info`/`list_dir`, `src/modules/critic/tools.ts`,
  выполнение через общий `ToolExecutor` с read-only allowlist) и выносит финальный вердикт по их выводам.
  Лимит — общий таймаут verify, fail-open к вердикту первого прохода.

### Honest-Stop & Artifact-Claim Verification (unreleased, ветка `fix/honest-verify-stop-retry`)

Живой прогон qwen3.5-9b через `mma web` (сессия `ses_mul5pepu_9mdq90`) показал два просачивающихся
паттерна: выдуманный успех (показанный вывод без запуска, «валидный» XML с mismatched-тегом) и
retry-петля после блоков (перебор python/python3/bun/pip). Контрмеры детерминированные, не LLM:

- **Honest-stop стрика** (`tool-batch.ts`, `loop-state.ts`, `constants.ts`):
  `consecutiveFailedBatches` — только полностью провальные пакеты (tool-level блоки входят,
  `result.blocked` плагинов нейтрален по контракту, успехи/смешанные пакеты сбрасывают).
  На 4-м (`MAX_CONSECUTIVE_FAILED_BATCHES`) — директива `exec.honest_stop` («остановись, ответь
  честно, вывод не выдумывай»); на 6-м (`HARD_STOP_FAILED_BATCHES`) — жёсткий стоп с
  `retryLoopStopped` (success:false, `error.retry_loop_stopped`). Тесты:
  `tests/core/tool-batch-honest-stop.test.ts`.
- **Проверка заявлений** (`src/modules/hallucination/artifact-claim.ts`,
  `src/core/agent/artifact-resolve.ts`, wiring в `hallucination-gate.ts`/`agent.ts`):
  `checkXmlWellFormed` (без зависимостей) заведён в `preValidateSyntax`
  (.xml/.drawio/.svg/.xaml/.plist/.iml); `checkArtifactClaims` (файл заявлен как создан/валиден,
  но отсутствует/не парсится) и `checkUnverifiedOutput` (вывод подан как результат запуска без
  успешных exec-тулов `bash/process_wait/pipeline_run`) делят bounded retry-бюджет
  `MAX_CLAIM_CHECK_RETRIES` — отдельный счётчик на класс (`claim/artifact/output`),
  иначе один съеденный бюджет экранирует другую ложь в том же ответе (fail-open). Честное хеджирование («ожидаемый», «для справки») —
  пропуск. Резолвер ограничен baseDir (jail), 10 путями, 500KB; `.drawio` добавлен в
  `FILE_EXTENSIONS` токенайзера. i18n: `hall.claim_artifact`, `hall.claim_output_unverified` (en+ru).

### LSP Doctor & Locked-Down Networks (2.17.0)

**LSP = Language Server Protocol** (протокол языковых серверов) — стандарт связи
редактора с языковым сервером; тот же движок, что подсвечивает ошибки в VS Code.
В MMA (`src/modules/lsp/`) один JSON-RPC клиент поверх stdio гоняет серверы по
языкам и подмешивает их диагностики в контекст модели (проверка кода без сборки).

- **`/lsp doctor`** (`src/cli/repl-commands-lsp.ts`, `src/modules/lsp/diagnose.ts`):
  per-server диагностика для ответа «почему LSP не работает» — применимость, наличие
  бинарника в PATH, пойдёт ли через npx, реальная проба `spawn+initialize` и класс
  причины (`ok/disabled/not-applicable/binary-missing/offline/network/timeout/spawn-failed/server-error/deadline`)
  с actionable `↳`-подсказкой. Фасад — `LspModule.diagnose(baseDir, deps?)`.
- **npx-резолв вынесен** в `src/modules/lsp/resolve.ts` (`findOnPath`, `resolveNpxLaunch`,
  `isOfflineLsp`); `client.startServer` использует его, глобальный бинарник важнее npx.
- **Офлайн-режим** (`config/env.ts`, `config.lsp.offline` + env `MMA_LSP_OFFLINE`): npx не
  вызывается вообще; сервер, которому он нужен, падает с `offline: <binary> not found in PATH`.
  Env сильнее конфига (`isOfflineLsp(env?, configOffline?)`). Правки `lsp.servers.<lang>`
  (`command`/`args`/`env.npm_config_registry`/`autoInstall`/`enabled`) — через JSON-конфиг.
- **Настройка LSP из UI** (`lsp.enabled`/`lsp.offline` в реестре `/config` и Settings → Plugins·LSP;
  вкладка LSP в web — кнопка `ⓘ`): глобальные тумблеры живьём через `LspModule.setEnabled/setOffline`
  (+ `getFlags` в `GET /api/lsp/doctor`; `config-api` сбрасывает кэш `lspDoctor`). Для применимых
  проблемных серверов (`useNpxFallback`/`binary-missing`/`offline`/`network`) диагноз несёт
  `installCommand` (`npm i -g <packages>`, `rustup component add rust-analyzer`, `go install .../gopls@latest`) —
  показывается во вкладке LSP и в `/lsp doctor`. Тесты: `tests/modules/lsp/diagnose.test.ts`,
  `tests/lsp-module.test.ts`, `tests/webui-config.test.ts`, e2e `web-lsp`.
- **Классифицированные hints**: под `[LSP check failed]` идёт одна строка `hint:` нужного
  класса (`lsp.hint_*`), чтобы модель уходила на build/test. Порог 3 подряд → `[LSP disabled]`
  без изменений.
- Доки: `docs/agents/tools.md` → «LSP Diagnostics → Locked-down networks».

### WebUI Modularization (unreleased, phases 5–6)

План: [docs/plans/2026-10-02-webui-modularization.md](./docs/plans/2026-10-02-webui-modularization.md);
спека: [docs/specs/2026-10-02-webui-modularization-design.md](./docs/specs/2026-10-02-webui-modularization-design.md).
Внутренний рефакторинг, контракты (SSE/REST/сессии/конфиг/plugin API) не менялись.

- **Фронтенд-раскладка (barrel + подпапки).** `assets/js/feed.ts` — barrel над
  `feed/{core,sidebar,stream,turn,history,plan,question}.ts`; `feed/core.ts` держит
  контейнер/липкий-скролл/сворачивание recon-ранов и общие render-хелперы
  (`mdOpts`/`buildThinkBlock`/`appendActionsRow`). `assets/js/tabs.ts` переехал в
  `session/tabs.ts` (hub) + `session/{composer,sessions-menu,cmdk}.ts`. `assets/js/settings.ts`
  — barrel над `settings/{write,panels,providers,modal,subdialog,search,form}.ts`
  (`controls/editors` — с phase 3). `sidebar.ts`/`store.ts` — тоже бары.
- **Разрыв циклов через DI (не обратные импорты).** Siblings не импортят hub: операции
  приходят через `initComposer(...)`/`initSessionsMenu(...)`/`initCmdk({autogrow})`,
  вызываемые в конце `session/tabs.ts`. В настройках `postConfig` — единый funnel в
  `settings/write.ts` (низ), UI-ререндеры (`renderSettings`/`openSettingsAt`) регистрируются
  им через `setWriteHooks`; `search` импортит `modal` только в одну сторону.
- **Срезы `S` (phase 6).** `assets/js/store.ts` — barrel над
  `core/store/{index,feed,tabs,settings,session}.ts`. Каждый домен владеет своим объектом
  (`feed`/`tabs`/`settings`/`session`), потребители импортят нужный срез; старый god-object
  `S` (и `S.state`) **удалён** (`grep '\bS\.'` в `assets/js` пуст).
- **Guard-тесты.** `tests/webui-boundaries.test.ts` (+ `tests/helpers/import-graph.ts`) —
  AST-граф бэкенд-импортов: циклы и правило «доменные модули зависят от role-интерфейсов,
  а не от композитного `WebUiState`». `tests/webui-frontend-graph.test.ts` — ацикличность
  `assets/**` + отсутствие инверсий слоёв (список `KNOWN_INVERSIONS` пуст). Ворота после
  перехода на TS: `tsc -p tsconfig.frontend.json` (см. ниже) и `bun build
  assets/app.ts --target=browser` (резолвит именованные импорты/экспорты).

### WebUI Frontend TypeScript Migration (2.17.1)

Спека: [docs/specs/2026-10-04-webui-frontend-ts-design.md](./docs/specs/2026-10-04-webui-frontend-ts-design.md);
план: [docs/plans/2026-10-04-webui-frontend-ts.md](./docs/plans/2026-10-04-webui-frontend-ts.md).
Весь наш браузерный фронтенд переведён на TypeScript со `strict: true`; контракты
(URL/имена файлов, REST/SSE/сессии/конфиг) не менялись.

- **Исходники — `.ts`.** `assets/app.ts`, `md.ts`, `setup.ts`, `js/**/*.ts`
  (вендоренные `smd.js`/`hljs.js` остаются `.js`). Импорты — с `.js`-суффиксами
  (валидно и для `tsc` Bundler-резолюции, и для браузера после транспиляции).
- **Проверка:** новый `tsconfig.frontend.json` (`lib: DOM`, `strict`, `noEmit`),
  основной `tsconfig.json` **исключает** `src/modules/webui/assets/**`; `quality` +=
  `typecheck:frontend` (`tsc -p tsconfig.frontend.json`). `allowJs: true` оставлен
  **только** ради импорта вендоренного `smd.js` из `md.ts` (наш код — весь `.ts`).
- **Транспиляция на лету (dev/тесты):** `loadAssets()` (`src/modules/webui/assets.ts`)
  при чтении `.ts` прогоняет через `Bun.Transpiler` и отдаёт `.js` под тем же ключом
  (`js/foo.js`); `web:dev` без шага сборки. В prod ассеты уже готовы (`build:frontend`).
- **Prod-сборка:** `scripts/build-frontend.ts` пофайлово транспилит `.ts` → `dist/assets`
  (имена и граф модулей сохранены) и копирует вендор/html/css; `build:prod` =
  `clean → bundle → frontend → copy-assets → optimize`.
- **Guard:** `tests/webui-frontend-graph.test.ts` читает `.ts`; строковые guard'ы,
  зависящие от форматирования (`if (…) return;`), сделаны whitespace-толерантными
  (транспилятор переносит `return` на новую строку).

### npm Build Optimization (2.17.1)

Спека: [docs/specs/2026-10-04-npm-build-optimization-design.md](./docs/specs/2026-10-04-npm-build-optimization-design.md);
план: [docs/plans/2026-10-04-npm-build-optimization.md](./docs/plans/2026-10-04-npm-build-optimization.md).
Прод-пакет **8.17 MB → 1.73 MB**, `main.js` **7.68 MB → 1.11 MB**. Контракты не менялись.

- **Внешние зависимости:** `build:bundle` = `bun build … --packages external`.
  Зависимости (все в `dependencies`) резолвятся из `node_modules` при запуске —
  в рантайме ничего не докачивается из сети.
- **Минификация:** `scripts/optimize-dist.ts` (esbuild) минифицирует `dist/**/*.{js,mjs,css}`
  (`charset: "utf8"` — иначе кириллица эскейпится в `\uXXXX` и ru-словарь пухнет ~2×)
  и `*.json` через `JSON.parse/stringify`. Mangling идентификаторов = лёгкая
  обфускация; sourcemaps не кладём. `build:prod` = `clean → bundle → frontend →
  copy-assets → optimize`.
- **Чистота:** `scripts/clean.ts` (портативно вместо Windows-only `cmd`),
  `build-frontend` пропускает пустые type-only транспиляции (0-байтный `types.js`).
- **Лёгкий tiktoken:** `token-counter.ts` использует `js-tiktoken/lite` +
  `js-tiktoken/ranks/cl100k_base` (~1.1 MB вместо ~5.6 MB всех таблиц); `estimateTokens`
  перекалиброван под cl100k (кириллица ≈ /2.5).

### Project Map Indexer (2.18.0)

Дизайн-разбор и лучшие практики: `docs/analysis/2026-10-04-indexer-search-ideas.md`. Контракты
(`project_map` — тот же тул, SSE/REST не менялись) сохранены; аддитивные изменения.

- **Символы с позициями** (`src/modules/indexer/symbols.ts`): `extractSymbolsDetailed` отдаёт
  `{name, line, kind}`; `extractSymbols` (только имена) остаётся. Порядок — по строке исходника.
- **Ранжирование `find`** (`src/modules/indexer/rank.ts`): definition-first, path-aware
  (точный символ → префикс → подстрока → путь; код → тесты → доки; короче путь, стабильно).
  Замер на этом репо: MRR 0.93→1.00, Hit@1 0.90→1.00 на 60 символьных запросах.
- **Новые действия `project_map`**: `symbol` (места определения `path:line name (kind)`) и
  `outline` (оглавление файла по строкам). Тул-набор не растёт — действия в существующем тулe.
- **Сигнатуры символов без парсера** (`symbols.ts`, `readSignature`): текст объявления до
  `{`/`;`/конца строки с учётом глубины скобок (многострочные параметры) — `symbol`/`outline`
  показывают API, а не только имя (покрытие на этом репо ~83%, стоимость индексации не выросла).
- **Инкрементальный пересбор** (`walker.ts`, `cache.ts`, схема кэша v3): `IndexedFile` несёт
  `size`/`mtimeMs`; `walk(prev)` не читает совпавшие файлы и перечитывает только изменённые
  (1 файл на 3000-файловом дереве: ~302→168 мс, 1.8×). `IndexCache.loadForReuse()` — без
  сигнатуры (per-file reuse), строгая `load()` сохранена как быстрый путь «ничего не менялось».
- **Конфиг** `indexer.maxFiles` (default **1000→5000**) и `indexer.respectGitignore` в
  `/config` и Settings → Context → Project index; при упоре в кап карта помечается
  `[!] Index truncated…`, а не молча отдаёт подмножество.
- **`.gitignore`/`.mmaignore`** (`src/modules/indexer/gitignore.ts`, fail-open; комментарии,
  `!`-негация, `/`-якорь, `dir/`, `*`, `?`, `**`). На этом репо 971→934 файла.
- **PageRank-карта под токен-бюджет** (`src/modules/indexer/graph.ts`, `rank.ts`): граф
  файл→файл из импортов/require (`extractImports`, резолв `./`,`@/`,`~/`, index-файлов),
  PageRank (damping 0.85, 20 итераций), `selectByRank` под `indexer.mapTokenBudget`
  (default 1500) вместо фиксированных 80 файлов. На этом репо карта 2444→1481 токенов
  (80→40 файлов), наверх выходят хабы (`src/config/types.ts`, `lsp/types.ts`). Граф ленивый,
  кэш на объект индекса (`getRanks`).
- **LSP-фолбэк для `symbol`** (`src/modules/lsp/symbols.ts`, `client.ts`, `module.ts`,
  `config.ts`; `IndexerModule.setSymbolProvider`): когда индекс не нашёл совпадений,
  `project_map symbol` спрашивает LSP `workspace/symbol` (правильный примитив для
  поиска по имени; `textDocument/definition` требует позицию). Wire в `modules-phase`:
  сервер спавнится только на мисс, ошибка/выключенный LSP тихо откатываются на индекс.
- **Тесты:** `tests/modules/indexer/{rank,gitignore,symbols,incremental,module-search,graph}.test.ts`,
  `tests/modules/lsp/symbols.test.ts`.

### Current Version: 2.18.0

### Changelog

Все изменения документируются в `CHANGELOG.md` (формат [Keep a Changelog](https://keepachangelog.com/)).

**Правило:** при каждом релизе (MINOR/PATCH) — добавляй запись в `CHANGELOG.md` в секцию `## [X.Y.Z] - YYYY-MM-DD`. Группируй по Added/Fixed/Changed/Removed. Пиши на английском, кратко и по существу. Формат ссылок: `**Module**: description`.

При публикации (`npm publish`) changelog автоматически попадает в пакет и виден пользователям при установке (`npm info micro-models-agent`).

**⚠️ npm publish асинхронный:** реестр отвечает `PUT 202 Accepted` («being processed…»), и версия может несколько минут не появляться в `npm view`. `202` + `+ <pkg>@<version>` — уже успешная публикация; **не жди** фактического появления, сразу тегируй/пушь. Детали — [docs/agents/versioning.md](./docs/agents/versioning.md), шаг «Publish».

### Versioning Rules

Версии — **вехи**, а не счётчик PR. Один MAJOR на пакет ломающих изменений, а не на каждую итерацию.

**PATCH** — bug fixes, i18n, docs, tests, performance, non-breaking dependency updates.

**MINOR** — new CLI/REPL commands, new tools, new modules, new config options, new behavior; **renaming with a working deprecation alias**; additive `--json` fields.

**MAJOR** (редко) — только реальная поломка **без пути совместимости**:
- несовместимая схема конфига / нечитаемые старые сессии;
- удаление команды/тула/модуля **без алиаса**, выпущенных в опубликованном релизе;
- ломающее изменение `LLMProvider` / plugin API / `--json` контракта;
- architecture rewrite, меняющий контракты поведения.

**Правила сдержанности:**
1. MAJOR требует хотя бы одной записи в `### Removed` / `### Changed (breaking)` CHANGELOG — иначе не MAJOR.
2. Предпочитать **алиас + MINOR** вместо жёсткого переименования + MAJOR.
3. Не более одного MAJOR на пакет ломающих изменений; не бампать MAJOR без явного запроса.
