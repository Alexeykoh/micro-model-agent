# MMA v2 — Micro Models Agent

General-purpose AI agent harness for small models (Qwen3.5-9B, 32K-64K context). Complete rewrite from MMA v1. **Not a coding-only agent** — see Positioning below.

> **Design spec:** [docs/specs/2025-07-28-mma-v2-design.md](./docs/specs/2025-07-28-mma-v2-design.md) — architecture, modules, tools, CLI, config, data flow.

> **Literature:** [docs/literature.md](./docs/literature.md) — agent harness engineering best practices audit (Anthropic, OpenAI, LangChain, HuggingFace, deepset, Martin Fowler).

> **UI Style (канонический):** [docs/design/ui/STYLE.md](./docs/design/ui/STYLE.md) — **единственный верный** стиль чат-вывода агента. Мокап: [docs/design/ui/mockup-chat-en-ru.html](./docs/design/ui/mockup-chat-en-ru.html) (EN слева, RU справа). Любой код, конфликтующий со STYLE.md, считается неправильным и подлежит приведению к стилю.

> **Этот файл должен периодически обновляться при изменениях в проекте.** При добавлении новых модулей, тулов, команд, изменении архитектуры или конфигурации — обнови соответствующий раздел ниже. AGENTS.md должен всегда отражать актуальное состояние проекта, чтобы агенты и разработчики имели достоверный контекст.

> ## ✅ P0 Harness Hardening — ВЫПОЛНЕНО (2026-10-05, ветка `fix/harness-hardening`)
>
> Разбор живой сессии `ses_muu8kfbw_nyxkre` (`qwen3.5-9b`, `mma web`) выявил
> первопричинные дефекты харнесса: ложная компакция и потеря рабочего контекста,
> оценка токенов до **4.85×** от реальной, рассинхрон плана/шагов, неработающий
> `grep` на Windows, утечки фоновых процессов. Все фазы 0→4 закрыты (по коммиту
> на фазу, `bun test` + `tsc --noEmit` зелёные, `bun run quality` exit 0).
>
> - **Спека (инварианты §1):** [docs/specs/2026-10-05-harness-hardening-design.md](./docs/specs/2026-10-05-harness-hardening-design.md)
> - **Реализация:** см. раздел «Harness Hardening (2.19.0)» ниже.
> - **Generality:** исправления обобщены (grep JS-фолбэк, optional checks, калибровка
>   без привязки к языку/задаче); не-кодовые шаги самоподтверждаются `manual:`.

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
| [service-api.md](./docs/agents/service-api.md)   | Agent Service API v1: endpoints, envelope, config, errors, webhook                                                      |
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

- **Планировщик и модель по умолчанию:** `moe.enabled: true` без `orchestrator.model` **не выключает MoE** — оркестратор стартует на активной модели агента (`fallbackModel`/`fallbackProvider` в `OrchestratorClient`, `src/llm/orchestrator.ts`). `orchestrator.model` без `orchestrator.provider` строит провайдер на активном провайдере с другой моделью. Ключи `orchestrator.model` / `orchestrator.provider` / `orchestrator.contextWindow` заведены в реестр (домен `provider`), доступны в `/config` и web-settings (Agent → Mixture of experts).
- **provider-ссылки:** `critic.provider` / `orchestrator.provider` — строка-имя записи `provider.entries[]` (резолв — `resolveProviderRef`, `src/modules/providers/resolve-ref.ts`) либо полный объект (legacy/ручная правка). UI показывает выпадающий список имён.
- **Выпадающие списки:** редактор `editor.kind: "select"` (`optionsSource: "models" | "providers"`) в `controls.ts`/`editors.ts` — `critic.model`, `orchestrator.model`, колонка `experts[*].model`; источник — живые `settings.models` / `provider.entries`, фолбэк — text-input.
- **Re-plan цикл:** `moe.maxReplanCycles` (default 3); каждый re-plan ревалидируется (`plan-validator`);
  битый re-plan → честный partial failure; knownTags — из реестра тулов.
- **Эксперты:** `config.experts` рендерится в PLAN_SYSTEM_PROMPT (`ExpertConfig.description`,
  фолбэк — tool_tags). Провайдер строится общим `buildManagedProvider`
  (`src/modules/providers/managed.ts`; per-entry contextWindow/retry/rateLimits, legacy
  `{type,baseUrl,apiKey}`, `orchestrator.contextWindow` — глобальный фолбэк).
- **Пер-экспертная модель:** `experts[tag].model`, отличная от активной, исполняется на
  выделенном провайдере поверх активного провайдера (`resolveExpertProvider`,
  `src/modules/execution/expert-provider.ts`; совпадение/пусто → общий провайдер, ошибка сборки →
  fail-open). Раньше поле было мёртвым — все эксперты шли на активной модели.
- **Критик:** `buildCriticProvider` использует тот же `buildManagedProvider`.
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
- **Режим auto vs ручное окно (`contextAuto`, unreleased):** ключ `contextAuto` (bool, default `true`,
  домен `budget`, `src/config/registry-extra.ts`) решает, перетирает ли проба выбранное значение.
  Auto (дефолт = прежнее поведение) — проба применяется на старте (`provider-phase.ts`) и при смене
  модели/провайдера (`Agent.reprobeActiveProvider`, при ручном режиме сеть не гоняется вовсе).
  Ручной режим — любая запись конкретного `contextWindow` (`setConfigValue`, `src/config/registry.ts`)
  выставляет `contextAuto:false`, и проба больше не трогает окно; флаг переживает рестарт (домен `core`).
  Поверхности: пункт `auto` в контекстном селекторе веба (кнопка `context: auto`, разрешённое число —
  в sub-строке пункта) шлёт `POST /api/config {contextAuto:true}`; хендлер (`settings/config-api.ts`)
  до персиста/reconfigure гоняет пробу через `applyAutoContext` (`settings/context-auto.ts`, общий
  `probeProviderContext`, deadline 4s) и отвечает `{contextWindow, probed}` — молчание провайдера
  озвучивается тостом `web.selectors.auto_failed` (fail-open). `/config contextAuto` и тумблер
  Settings → Context идут тем же путём. Тесты: `tests/config/context-auto.test.ts`,
  `tests/webui-config.test.ts`, guard в `tests/webui-assets.test.ts`.
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
- **Transport:** SSE `GET /events` (`state, text, meta, reasoning, phase, tool_start, tool_end, turn_end, usage, plan, command, error, log, retract, index`); REST `GET/POST /api/config`, `GET /api/models`, `GET /api/state`, `POST /api/message`, `POST /api/interrupt`, `POST /api/command`, `POST /api/answer`, `GET /api/i18n`, `GET/POST /api/sessions`, `POST /api/sessions/activate`, `DELETE /api/sessions/:id`, `GET /api/sessions/:id/history`, `GET /api/sessions/:id/log`, `GET/POST /api/memory`, `DELETE /api/memory/:category/:n`, `GET /api/skills`, `GET /api/plugins`, `GET /api/file?path=` (просмотр файла из карточки, ответы `text/plain`); static `/`, `/app.js`, `/styles.css`. Auth: loopback по умолчанию, non-loopback требует токен; same-origin на запись; caps на body/клиентов. GET-навигации (клик по карточке) аутентифицируются HttpOnly `SameSite=Strict` cookie `mma_web_auth`, которую сервер ставит на любой успешный запрос, — токен в URL ссылки не попадает.
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
  квадратные Lucide-иконочные вкладки **Session / Files / LSP / Trace / Plugins / Map** сверху сайдбара
  (порядок из `TABS`, `sidebar/state.ts`; он же порядок `Alt+1..6` и `←/→`); имя активной
  вкладки показано строкой ниже вкладок. Дефолт — Session; последняя вкладка помнится в
  `localStorage["mma-sidebar-tab"]`; вкладка и панель Trace скрыты на ≤760px.
  Логика порядка (2.32.0): сначала то, куда смотрят во время хода (Files), затем диагностика
  (LSP, Trace), затем Plugins, а проектная карта Map — в хвосте: её открывают осознанно.
  Guard: `tests/webui-assets.test.ts` сверяет порядок `TABS` с порядком кнопок в `index.html`.
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
  (сайдбар фиксирован `679px`, панель `.trc-detail` с метаданными/аргументами/выводом встаёт слева от списка).
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

### Harness Hardening (2.19.0)

Спека: [docs/specs/2026-10-05-harness-hardening-design.md](./docs/specs/2026-10-05-harness-hardening-design.md).
Правки харнесса (не модели), обобщённые; фазы 0→4, по коммиту на фазу.

- **Калибровка контекста** (`src/core/agent/context-calibration.ts`): оценка токенов
  калибруется по реальному `prompt_tokens` (baseline+delta, EMA-fallback, floor-ratio
  против усечения провайдером, shadow-warmup, stale-фолбэк). `ContextManager.getContextTokens()`
  — единственный вход порогов компакции; `getEstimatedTokens()` остаётся raw (cost/prefix/critic).
  Safety-clamp `isImplausibleJump` (>3× и >20K без роста сообщений) блокирует ложную overflow-компакцию.
  Кэш оценки сообщения ключуется по сигнатуре контента (детект in-place мутаций — класс «+44K»).
- **Компакция v2** (`contextBudget.policy: legacy|v2`, default `v2`): канонический порог по
  `history`, overflow cooldown, гарантия прогресса (prune старых tool-результатов → агрессивный
  тримминг → hard drop), pinning задачи/плана, один триггер на итерацию, реактивная компакция
  на context-length ошибку (circuit-breaker раз на ход). `legacy` = 2.18.2.
- **План:** `execution.autoAdvance` (default true); авто-архив перенесён с auto-advance на
  `onTurnEnd` (`archiveCompletedPlan`, хук execution-плагина); `plan.no_active` несёт последний
  завершённый план; `checks` необязательны (self-certified `manual:<шаг>`), mismatch-ошибка с числами.
- **Тулы:** zero-dep JS-фолбэк `grep` (`src/tools/grep-js.ts`; rg → grep → JS, gitignore/maxFiles/
  лимиты) + `tools.grepEngine: auto|rg|grep|js`; generic bash-редирект tool-as-command и `--cwd`→`workdir`;
  `ProcessRegistry.start(..., { force })` дедуп одинаковых фоновых команд.
- **Слабо-модельный UX:** `ToolResult.errorMeta` (`appendErrorMeta` в tool-batch — модель видит,
  чат нет); fuzzy top-3 `load_skill` (`nearestSkillNames`); пустой web-сабмит → `200 {noop,notice}`.

### Harness Reliability Fixes (2.20.0)

Разбор живой сессии `ses_muwinhpk_2e69iq` (`mma web`, локальный 27B): критик молча
пропускался после компакции, компакция не несла информации → петля переисследования,
read-only петля без стопа, рассинхрон провайдера/контекста, выдуманный артефакт,
редакция съедала URL в истории. План: [docs/plans/2026-10-06-harness-reliability-fixes.md](./docs/plans/2026-10-06-harness-reliability-fixes.md).

- **Критик после компакции** (`src/core/agent/critic-gate.ts`, `agent.ts`): маркер захода —
  монотонный `seq` сообщения в `WeakMap` (`ContextManager.beginTurn/seqOf`), а не индекс
  массива; переживает удаление истории спереди. Раньше `gatherTurnToolEvents` при компакции
  получал пустой срез и критик не запускался на длинных ходах.
- **Read-only бюджет** (`src/core/agent/tool-batch.ts`, `constants.ts`): `MAX_READONLY_BATCHES=8`
  (директива `exec.readonly_directive`) → `HARD_STOP_READONLY_BATCHES=12` (честный стоп
  `error.readonly_loop_stopped`). Пакет «без рабочей мутации» (по `isWorkMutation`: не write/edit/
  delete/move/create_dir/bash; browser/web/plan/todo считаются исследованием) — сбрасывается только
  реальной мутацией. Успешные fetch-и не ловились honest-stop (тот про провалы).
- **Леджер тулов при компакции** (`src/modules/context/manager.ts`): pin `[Tool ledger]`
  (`tool(args) → digest`, дедуп, cap 12) через компакции; `contextBudget.compactionSummary: off|ledger`
  (default `ledger`). Модель видит, что уже прочитано/fetched, и не повторяет.
- **Целевая редакция логов** (`src/modules/security/data-sanitizer.ts`): `sanitizeLogMessageTargeted`
  (без generic-правила `{30,}`) для tool-args/результатов и user-сообщений; URL/слаги/хеши
  сохраняются, секреты маскируются. `sanitizeLogMessage` (строгий) — для команд.
- **Веб-контент** (`src/tools/html-content.ts`, `web-fetch.ts`, `web-search.ts`): `extractMainContent`
  (плотнейший `<main>`/`<article>`), детект JS-шелла (`tool.web_fetch_no_content`), `unwrapDdgUrl`
  разворачивает редиректы DDG в прямые URL.
- **Web-grounding критика** (`src/modules/critic/evidence.ts`, `client.ts`): `EvidencePack.webGrounding`
  (`attempted`/`verified`/`unverifiedClaims`); числовые/ценовые утверждения без содержательного fetch → issue.
- **Web-claim проверка** (`src/modules/hallucination/web-claims.ts`, `hallucination-gate.ts`): суммы в финальном
  ответе (`45 000`, `15000 BYN`) сверяются с текстом успешных web-тулов; не найдены → один bounded retry
  (`hall.claim_web_unverified`), а не молчаливая выдумка. Промпт-правило `WEB RESEARCH` в `system-prompt.ts`.
- **File-creation claim** (`src/modules/hallucination/file-creation-claim.ts`): если задача просила файл, а
  ответ заявляет о сохранении, но `write_file`/`edit_file` за ход не вызывался → один bounded retry
  (`hall.claim_file_not_created`). Guard-ы (file-intent, вне фенсов/цитат, без контекста статьи/доков)
  не дают срабатывать на простом упоминании файлов в пересказе.
- **Провайдер hot-swap** (`src/core/agent.ts`): `setProvider` делегирует в `reconfigure`
  (re-probe + resize), приватный `reprobeActiveProvider`; `SessionManager.setEffectiveContext`
  синхронит `meta.contextWindow`/`model`; раннер строит `envReport` от своего конфига, а не bootstrap-снимка.
- **subagent** (`src/tools/subagent.ts`, `executor.ts`, `types.ts`): `expert_tag` резолвится в
  `tool_tags` эксперта (неизвестный → ошибка со списком); `subagent.timeoutMs` (default 180000),
  `ToolDefinition.timeoutMs` может быть функцией от `ctx`.
- **Мелочи:** транзиентные `web_fetch`/`web_search` фейлы не пишутся в память; POSIX-`workdir`
  на Windows (`/tmp`, `/Users/…`) отклоняется с хинтом `bash.posix_workdir_hint`.
- **Plan `checks` self-repair** (`src/modules/execution/module.ts`): несовпадение длины `checks`/`steps`
  не отклоняет `create` — недостающие проверки добиваются self-certified `manual:`, лишние
  отбрасываются (отказ заставлял слабую модель вообще бросить планирование).
- **Reasoning на петле** (`src/modules/reasoning/policy.ts`): повтор идентичного вызова (застревание)
  поднимает effort до `high` (раньше — понижало до `low`); рутинные успешные записи по-прежнему `low`.

### Harness Reliability Fixes — 2.21.0 (аддендум к 2.20.0)

- **Web-claim** (`src/modules/hallucination/web-claims.ts`): суммы в финальном ответе сверяются с текстом
  успешных web-тулов; не найдены → bounded retry `hall.claim_web_unverified`.
- **File-creation claim** (`src/modules/hallucination/file-creation-claim.ts`): задача просила файл, ответ
  заявляет сохранение, но `write_file`/`edit_file` не было → bounded retry `hall.claim_file_not_created`.
  Guard-ы (file-intent, вне фенсов/цитат, без контекста статьи/доков) — не срабатывает на пересказе.
- **Read-only бюджет по рабочей мутации** (`src/core/agent/tool-batch.ts`): стрик растёт на любом пакете
  без `isWorkMutation` (browser/plan/todo больше не сбрасывают) → ловит browser/web-петли.
- **`session_start` эффективное окно** (`src/core/agent.ts`): env-срез берёт `model`/`contextWindow`
  из живого конфига (probe), а не из bootstrap-снимка.
- Проверено 12 живыми прогонами `prism-ml/bonsai-27b`; план — [docs/plans/2026-10-06-harness-reliability-fixes.md](./docs/plans/2026-10-06-harness-reliability-fixes.md).

### Web Live Context Metrics & Cache Reporting (2.22.0)

- **Live контекст в сайдбаре** (`src/modules/webui/session/run-agent.ts`, `host-state.ts`,
  `turns.ts`, `assets/app.ts`): `makeRunAgent` получает `contextManager` (живой `ContextManager`
  вкладки) и, пока ход бежит, раз в ~800мс читает `getSnapshot()` через `liveContextUsage`
  (`host-state.ts`) и шлёт **новое SSE-событие `usage`** владельцу (`usageSessionId`). Ранее
  `contextUsed`/`contextBreakdown`/`compactionCount`/`contextQuality` снапшотились только в
  `AgentResult` по завершении хода, и бар «замирал» до `turn_end`. Клиент мержит `usage` в
  `session.host` своей вкладки без полного `/api/state`-рефетча. Таймер останавливается в
  `finally` (прерывание/ошибка тоже). Cost/cache по-прежнему обновляются по завершении хода.
- **Анимация полосы** (`assets/js/feed/sidebar.ts`): `renderUsage` пересобирает панель целиком,
  поэтому сегменты полосы больше не прыгают в финальный `flex-grow` — `applyBarStep` сидирует
  новую полосу прежними ширинами (`lastBarParts`) и на следующем кадре ведёт к целевым
  (CSS `transition: flex-grow .25s`; гасится `prefers-reduced-motion`).
- **Cache hit-rate без ложного нуля** (`src/core/agent/cache-stats.ts` + `agent.ts`, `core/types.ts`,
  `src/cli/cache-line.ts`): выделенная чистая `computeCacheStats(state, saved)` выставляет `hitRate`
  **только** при наличии провайдерских cache-токенов. Prefix-монитор заполняет `stableRatio`
  всегда, из-за чего раньше `buildCacheStats` возвращал `hitRate: 0` на бэкендах без отчёта о кеше,
  и сайдбар показывал `0%` вместо `—`. `AgentResult.cache.hitRate`/`CacheReport.hitRate` — optional;
  тесты `tests/core/cache-stats.test.ts`, `tests/webui-live-usage.test.ts`.

### WebUI Files Tab (2.23.0; split/controls — 2.31.0)

Вкладка **Files** в сайдбаре `mma web`: ленивое дерево файлов workspace, read-only просмотр
в приложении и attach файла в чат вставкой пути. Спеки:
[2026-10-07-webui-files-tab-design.md](./docs/specs/2026-10-07-webui-files-tab-design.md),
[2026-10-08-webui-files-split-design.md](./docs/specs/2026-10-08-webui-files-split-design.md).

- **Листинг** (`src/modules/webui/file/files-api.ts`): новый `GET /api/files?path=<rel>` — JSON
  одной директории (папки сверху, затем файлы; кап `MAX_DIR_ENTRIES`, флаг `truncated`).
  Фильтр шума — примитивы индексатора (`isIgnoredDirName`/`isIgnoredFileName`, `.gitignore`/
  `.mmaignore`), protected-пути скрыты. Джейл — общий `resolveWorkspacePath`
  (`src/modules/webui/file/paths.ts`; на него же переведён `file-api.ts`).
- **Дерево** (`assets/js/sidebar/files.ts`, пятая вкладка `Alt+5`, Lucide `folder-tree`):
  lazy — папка фетчится при раскрытии (`expanded`/`listings` в `sb.files`), кэш инвалидируется
  событием. Стиль — строки + глифы (STYLE.md), без рамок.
- **Сплит вместо перехвата экрана (2.31.0):** `.files-body` = дерево (`#filesSide`) +
  `.files-splitter` + просмотр. Дерево **никогда не прячется** при открытии файла — раньше это
  делал CSS-хак `#pane-files:has(.files-detail:not([hidden])) .files-tree{display:none}`, и
  переключение файла требовало close → заново найти его в дереве → развернуть папки. Ширина
  дерева тянется мышью и с клавиатуры (`ArrowLeft/Right`, `Home`, dblclick), кламп 200–480px,
  дефолт 240px, персист в `localStorage["mma-files-tree-w"]` (`sidebar/files/split.ts`).
  Режим «только просмотр» — переключатель в шапке (`toggleViewerFull`/`setViewerFull`,
  класс `.f-full`), а не побочный эффект открытия файла; кнопка `disabled` без открытого
  файла, а закрытие просмотра (`✕`/`Escape`/смена workspace) **всегда возвращает дерево** —
  иначе «скрытое дерево + закрытый просмотр» даёт пустую вкладку.
- **История просмотра:** стек `files.history` + `histIndex` (`sidebar/files/history.ts`, cap 50),
  кнопки `←`/`→` и `Alt+←/→`; повтор текущего пути — no-op, путь «впереди» курсора переиспользует
  позицию (back/forward-семантика). Закрытие просмотра историю не стирает.
- **Управление раскрытием** (панель над деревом): «свернуть всё», «развернуть всё»
  (`EXPAND_DEPTH=4`, `EXPAND_DIR_CAP=200` запросов, батчи по 8, прогрессивная отрисовка; при
  упоре в кап — строка `web.files.expand_capped`, молчаливого обрыва нет), «обновить»
  (инвалидация кэша листингов + переоткрытие файла; раньше только по событию вотчера).
  На клавиатуре `*` раскрывает только предков курсора.
- **Клавиатура в дереве** (`sidebar/files/keys.ts`): строки — плоский список с `data-depth`,
  курсор `files.cursor` перерисовывается **на месте** (`paintCursor`: полная перерисовка
  уничтожила бы фокус). `↑/↓` — курсор, `→` — раскрыть/вниз, `←` — свернуть/к родителю,
  `Enter`/`Space` — открыть/toggle, `Home/End`, `*`. Слушатель на дереве + `stopPropagation`,
  чтобы не конфликтовать с глобальными `Alt+1..6`/`Escape`.
- **Хлебные крошки** (`#filesCrumbs`): каталоги приглушены и кликабельны (клик раскрывает папку
  в дереве и переводит туда курсор), имя файла яркое; длинный путь сворачивается в `…`.
- **Кнопки читаемы:** иконки Lucide 24×24 (`.fbtn`) вместо глифов `◧`/`✕` с хардкод-`title`
  по-английски; все `title`/`aria-label` через `t()`; attach-кнопка в строке — цель во всю
  высоту строки, на тач-устройствах (`@media (hover: none)`) видна всегда; строки —
  `role="treeitem"` с `aria-expanded`/`aria-selected`.
- **Просмотр**: текст — `fetch /api/file` + highlight.js (без `innerHTML`, через `DOMParser`);
  markdown — общий `renderMarkdown`; картинки/PDF/медиа — нативные элементы; код переносится
  по строкам; бинарь/лимит — локализованная ошибка (`web.file.error.*`). Никаких write-операций.
- **Attach = вставка пути**: иконка на строке + кнопка в шапке просмотрщика зовут
  `composer.insertIntoDraft` (DI через `initFiles`), вставляя `` `relpath` `` в черновик.
  Новый канал вложений НЕ вводится — существующий `parseMessageBody` (только `data:image/`)
  не тронут; путь читает агент через `read_file`.
- **Live**: `IndexerModule.watch(onSettled?)` зовёт колбэк после дебаунс-пересборки;
  web (`attachIndexWatcher(indexer, onChange)`) бампит `HostStateSnapshot.filesRevision` и шлёт
  SSE `files {phase:"changed"}` → вкладка перечитывает раскрытые папки и открытый файл
  (фолбэк — `filesRevision` в снапшоте, событие `state`).
- **Тесты**: `tests/modules/webui/files-api.test.ts`, `tests/webui-files-dom.test.ts`
  (23 кейса: регрессия «дерено пряталось», кнопки раскрытия, история, крошки, клавиатура,
  сплиттер, i18n), `tests/webui-index-watcher.test.ts`; guard в `tests/webui-assets.test.ts`
  (новая разметка + запрет возврата `:has()`-хака); обновлены `tests/webui-file.test.ts`.

### Web Tool Images (2.28.0)

Спека: [docs/specs/2026-10-07-web-tool-images-design.md](./docs/specs/2026-10-07-web-tool-images-design.md);
план: [docs/plans/2026-10-07-web-tool-images.md](./docs/plans/2026-10-07-web-tool-images.md).
Показ реальных изображений тулов (`browser` screenshot, `attach_image`) в ленте `mma web`
вместо статичной заглушки, которая никогда не заполнялась.

- **Доставка** (`src/tools/types.ts`, `src/core/types.ts`): тулы кладут полноразмерные байты в
  `ToolResult.imageFiles` (модель по-прежнему получает `ToolResult.images` — ресайзнутый data URL).
  `tool-batch` персистит ассеты (`SessionLogger.persistToolImages`) → `result.imageRefs` →
  `ToolEvent.imageRefs` → SSE `tool_end.images` + `tool_result.images` в `session.jsonl`.
  Шифрованная сессия (`sessionEncryption.enabled`) на диск не пишет: live — inline data URL
  (фолбэк в `forward.ts`), история — «недоступно».
- **Хранилище** (`src/modules/session/image-store.ts`): `<sessionDir>/images/<ts>-<rand>.<ext>`,
  ротация FIFO по `images.maxCount` (30) / `images.maxBytes` (100 МБ). Удаление сессии уносит
  каталог. `isSafeImageName` — джейл от traversal.
- **Эндпоинт** (`src/modules/webui/session/images-api.ts`): `GET /api/sessions/:id/images/:name`
  отдаёт байты с `Cache-Control: private, max-age=31536000, immutable`; 404 для чужой сессии,
  отсутствующего файла и небезопасного имени.
- **Фронтенд** (`assets/js/lightbox.ts`, `assets/js/feed/image-card.ts`): миниатюра
  `<img loading=lazy>` рисуется в `onToolEnd` по `data.images` (в любом verbosity, включая quiet);
  клик — лайтбокс (Esc/фон/✕, «открыть в новой вкладке», «копировать ссылку»). `onerror` (файл
  вытеснен ротацией) → `.imgcard-missing` «снимок удалён (ротация)». `feed/history.ts` реплеит те же
  миниатюры из `tool_result.images`.
- **`attach_image`** (`src/tools/attach-image.ts`): единый путь — возвращает картинку в
  `result.images` (очередь контекста заполняет `queueToolImages` в tool-batch), больше не зовёт
  `addPendingImage` сам.
- **Тулы**: `browser` при `action:"screenshot"` всегда производит PNG (даже для невидящей модели —
  модели уходит текстовая пометка, вебу картинка).
- **Конфиг** `images.maxCount` / `images.maxBytes` (домен `ui`, Settings → UI → Tool images),
  i18n `config.key.images.*` (en+ru); `web.card.image_removed`, `web.lightbox.*`.
- **Тесты**: `tests/session/image-store.test.ts`, `tests/core/session-logger-images.test.ts`,
  `tests/core/tool-batch-images.test.ts`, `tests/webui-session-images.test.ts`,
  `tests/webui-tool-image-events.test.ts`, `tests/webui-tool-images-dom.test.ts` (happy-dom,
  `tests/helpers/happy-dom.ts`).

### Event-Sourced Web State (2.24.0)

Спека: [docs/specs/2026-10-07-web-event-sourced-state-design.md](./docs/specs/2026-10-07-web-event-sourced-state-design.md);
план: [docs/plans/2026-10-07-web-event-sourced-state.md](./docs/plans/2026-10-07-web-event-sourced-state.md).
Убран двойной контур синхронизации сайдбара (SSE-счётчики + 2с-полл `/api/state`).

- **Снапшот в событии** (`src/modules/webui/session/session-status.ts`): `pushState(s, sessionId?)`
  шлёт полный `HostStateSnapshot` (через существующий `Host.getState`) с `sessionId` владельца.
  Заменяет все прежние `broadcast({type:"state", ...sessionStatus})` — в `turns.ts` (очередь/старт/
  ошибка/finishTurn), `run-agent.ts` (конец хода, usage уже записан), `module.ts` (re-index),
  `reconfigure.ts`. Поля `usage`/`usageSessionId` из события убраны (usage внутри снапшота);
  `usage`-событие (800мс во время хода) остаётся отдельным.
- **Событие `sessions`** (`sessions-api.ts`): create/activate/delete рассылают список; клиент
  рендерит его напрямую — 15с-полл `loadSessions` удалён (остаётся для boot/reconnect).
- **Per-tab снапшот** (`assets/js/state-sync.ts`, чистый, тестируемый): `routeState` пишет
  `tab.state` владельца, `mergeUsage` — live-usage владельца, `storeSnapshot` — REST-загрузку;
  guard по `sessionId` (поздний ответ/чужое событие не перетирают вкладку).
- **Клиент без таймеров** (`assets/app.ts`): SSE `state` → `applyState` (счётчики + `session.host`
  активной вкладки + рендер); `ensureTabState(id)` — из памяти или один REST; `refresh()` — только
  boot/reconnect; reconnect перечитывает все открытые session-вкладки (`resyncAfterReconnect`).
  `hooks.ensureTabState` заменяет `refreshState`; `setInterval(refresh,2000)`/`setInterval(loadSessions,15000)`
  удалены. `GET /api/state?session=` сохранён (boot/reconnect/ensure) — контракт не менялся.
- **Тесты**: `tests/webui-push-state.test.ts`, `tests/webui-state-sync.test.ts`; обновлён
  `tests/webui-assets.test.ts` (guard «нет клиентских поллов»).

### Parallel Subagents in a Tool Batch (2.25.0)

Спека: [docs/specs/2026-10-07-parallel-subagents-design.md](./docs/specs/2026-10-07-parallel-subagents-design.md).
Разбор живой сессии `ses_muxqw12h_6uk4cq`: два `subagent`-вызова одного хода шли строго
последовательно (сумма длительностей), хотя описание тула обещало «parallel work».

- **`ToolDefinition.parallelizable`** (`src/tools/types.ts`): тул можно гонять конкурентно с
  соседями по batch'у. Помечен только `subagent`.
- **`ToolExecutor.fork()`** (`src/tools/executor.ts`): изолированный исполнитель на один
  вызов — клон `ToolContext` по дескрипторам (живые геттеры `config`/`sessionId`/`capabilities`
  сохранены), свои `scope`/`recursionDepth`/`cleanup`/`activeCallId`; **общий** мемо/реестр/плагины,
  поэтому мутация субагента инвалидирует кэш чтений родителя.
- **`ToolBatchExecutor`** (`src/core/agent/tool-batch.ts`): жизненный цикл вызова разрезан на
  `prepareCall`/`executeCall`/`finalizeCall`. Подряд идущие `parallelizable`-вызовы (≥2): подготовка
  serial → конкурентное исполнение через `fork()` с капом `security.rateLimits.maxParallelTasks`
  (default 5) → финализация serial в исходном порядке. Одиночные и не-параллелизуемые — прежний
  serial-путь. Порядок `role:"tool"`-сообщений и UI-событий детерминирован.
- **Плагин-хуки сериализованы** (`src/tools/executor.ts`, `AsyncLock`): `onBeforeTool`/`onAfterTool`
  идут под общим FIFO-локом (один на корневой executor, наследуется форками) — stateful-плагины
  (execution stuck-detector, lint-on-write, LSP) не гоняются конкурентно между сиблингами; тело
  тула остаётся конкурентным. Лок берётся только при наличии хука (иначе не сдвигаем старт хендлера).
- **MoE-сабтаски изолированы** (`src/modules/execution/moe-executor.ts`): каждая сабтаска бежит на
  своём `fork()` — устранена гонка scope/recursionDepth между конкурентными волнами.
- **Тесты**: `tests/core/tool-batch-parallel.test.ts` (перекрытие, порядок, кап, serial не-параллельных),
  `tests/tools/executor-fork.test.ts` (изоляция, живые геттеры, общий мемо, сериализация хуков),
  `tests/core/subagent-parallel-e2e.test.ts` (реальный путь: registry→batch→fork→subagent handler с
  `agentFactory`-швом, без живой модели).

### Sidebar Responsive Drawer (2.32.0)

Правило: у сайдбара **два разных брейкпоинта**, потому что сайдбар и телефонный
хром отвечают на разные ограничения.

- **≤1024px — drawer** (`styles.css` + `js/sidebar/drawer.ts`): колонка `679px` не влезает рядом с
  чатом, поэтому сайдбар становится оверлеем поверх него. Именно drawer, а не «уже колонка»:
  master-detail панели (detail Trace 340px, дерево Files до 480px) в узкой колонке нечитаемы.
  Полный модальный контракт: backdrop (`#sbBackdrop`, `--sb-backdrop`, показывается **только** под
  `body.sb-open` — безусловный `display:block` перекрывал топбар (44 > 40) и съедал клик по самой
  кнопке), закрытие по клику вне и `Esc`, `role="dialog"`/`aria-modal` только пока
  открыт, Tab-ловушка (общий `trapTab` из `dialog.ts`), возврат фокуса на кнопку по закрытию.
  Scroll-lock не нужен и его нет: шелл уже `body { overflow: hidden }`, скроллится только `#msgs`.
  Открытый `.overlay` (settings/confirm) забирает `Esc` себе — он верхняя поверхность.
- **Измеряемый отступ вместо магического числа:** drawer уезжает под бары на их реальную высоту
  (`--sb-inset`, `applyInset()` на open/resize). Раньше был `top: 41px`, из-за чего на телефоне
  drawer уезжал под `.bar-sub` (38px), который появляется на том же брейкпоинте.
- **Синхронизация с вьюпортом:** `matchMedia(NARROW_MQ).addEventListener("change", syncToViewport)` —
  при выходе за 1024px колонка возвращается, а `body.sb-open` снимается. Без этого поворот
  планшета оставлял «открытый» drawer поверх раскладки без drawer'а, и он воскресал при сужении.
- **Стек master-detail в drawer'е:** `#pane-trace` → `column-reverse` (деталь сверху), `#pane-files` →
  `column` (дерево над просмотром), `.files-splitter` скрыт (вертикальный drag бессмыслен),
  `#pane-files.f-full .files-detail` на всю высоту. Ширина дерева теперь CSS-переменная
  `--files-tree-w` на `#pane-files` (не инлайновый `width`), поэтому drawer может её игнорировать.
- **Константы брейкпоинтов** (`js/sidebar/state.ts`): `NARROW_MQ = "(max-width: 1024px)"`,
  `PHONE_MQ = "(max-width: 760px)"`; `mqNarrow()`/`mqMobile()`. Телефонный хром (`.bar-sub`,
  узкие паддинги, скрытие Trace-таба) остался на ≤760px.
- **Осиротевшая панель Trace** (`sidebar/core.ts`): мобильный coercion `trace → session` срабатывал
  только по клику на вкладке, поэтому 900px → 390px (поворот/ресайз) оставлял панель Trace на экране
  без видимой вкладки. Теперь `matchMedia(PHONE_MQ)` с ре-вызовом `setSidebarTab(sb.active, false)`.
- **Тесты:** `tests/webui-sidebar-drawer-dom.test.ts` (8 кейсов: toggle, inset, dialog-семантика,
  Esc/backdrop, overlay-приоритет, sync по брейкпоинту, осиротевшая панель Trace); guard'ы в
  `tests/webui-assets.test.ts` (в т.ч. запрет `top: 41px` и безусловного `display:block` у backdrop);
  вьюпорты `tests/webui-smoke.test.ts` расширены до
  `[1440, 1024, 1000, 820, 768, 390]` + отдельный кейс на геометрию drawer'а.
  Внимание: этот suite исполняется только под Node-vitest с браузером; под `bun test` он skip,
  а под Node без `dist/assets` падает на `Bun.Transpiler` в `loadAssets()` (известное ограничение).

### Sidebar Fixed Width & Detail-on-Left (2.26.0)

- **Фиксированная ширина** (`src/modules/webui/assets/styles.css`): `.sb` — `679px` постоянно; убраны
  `transition` и `.sb-expanded { width: 680px }`, поэтому сайдбар больше **не расширяется самопроизвольно**
  при внешних событиях (замечено в секции с контекстом). Класс `sb-expanded` удалён из CSS и JS
  (`sidebar/trace.ts`, `sidebar/files.ts`); открытие/закрытие доп. секции — только по клику внутри сайдбара.
- **Деталь слева** (`#pane-trace`): `flex-direction: row-reverse` — панель деталей Trace встаёт слева от
  списка (ближе к чату), граница — `border-right`.
- **Просмотр файлов** (`#pane-files`): при открытом файле дерево скрывается, вьюер занимает всю ширину
  сайдбара (`:has(.files-detail:not([hidden]))`), код переносится по строкам
  (`white-space: pre-wrap; overflow-wrap: anywhere`), чтобы длинные строки были читаемы.

### Web Attachment Size (2.26.0)

- **До 10 вложений по 50 МБ**: клиент `MAX_IMAGE_BYTES` (`core/store/index.ts`) 6 → 50 МБ, `MAX_IMAGES`
  3 → 10 (клиент, `webui/util.ts`, пример-плагин); сервер `MAX_IMAGE_DATA_URL_BYTES` (`webui/util.ts`)
  6 → 70 МБ (base64 ≈4/3 файла + заголовок), `MAX_BODY_BYTES` (`webui/limits.ts`) 24 → 768 МБ
  (вмещает 10 × 50 МБ в base64). i18n `web.attach.too_large` обновлён (en+ru).

### Plugin Registry: метаданные, вкл/выкл, вкладка Plugins (2.29.0)

Спека: [docs/specs/2026-10-07-plugin-registry-design.md](./docs/specs/2026-10-07-plugin-registry-design.md)
(со статусом фаз). Реализованы **фазы 1–6** — плагин может отдать свой тул, а агент —
написать себе capability черновиком (`define_capability`), который не выполняется без
явного согласия пользователя.

- **Метаданные** (`src/modules/types.ts`, `plugins/records.ts`): `description`, `author`, `homepage`,
  `permissions`, `provides` — все опциональны; жёсткая валидация только на `name`
  (`^[a-z0-9][a-z0-9._-]{0,63}$`), остальное — warnings (`validatePluginMeta`). Плагин из 8 строк
  и оба примера не сломаны.
- **`PluginRecord`** — единственная read-модель для CLI/REPL/веба (`PluginManager.getRecords()`,
  кэш + инвалидация). `getFailures()` → `PluginLoadFailure[]`: непрогрузившийся плагин виден,
  а не исчезает. `loader.ts` ставит `plugin.path` и возвращает `LoadReport`.
- **Живой вкл/выкл**: `config.plugins.disabled` (deny-list, домен `plugins.json`). Единый путь
  записи — `setConfigValue`; эффект применяется через шов `setPluginGateApplier` →
  `PluginManager.setDisabledAll` (шов ставит `workspace-phase.ts`), поэтому `/config`, CLI и веб
  не могут разойтись. `PluginManager.active()` — единственная точка фильтрации для всех
  диспатчеров. Выключать можно до загрузки — пришедший позже плагин сразу off.
- **Поверхности:** `mma plugins list|show|enable|disable`, `/plugins …` (общий формат
  `plugins/format.ts`), `GET /api/plugins` (`{plugins, failures, mcp}`, `enabled` настоящий),
  `POST /api/plugins/:name {enabled}` (без `restartRequired`), SSE `plugins`.
- **Вкладка Plugins в сайдбаре** (`assets/js/sidebar/plugins.ts`, `Alt+6`, Lucide `puzzle`):
  строки с тумблером + dim-описание, отказы загрузки отдельными строками, подробности в
  существующем `#subOverlay` (`openSubDialog`, как у LSP), плюс тумблеры в Settings →
  Plugins · MCP и секция `plugins.registry`.
- **SDK:** `AgentPlugin`, `HostBridge`, `TurnSummary`, `PluginRecord`, `PLUGIN_PERMISSIONS`
  экспортируются из `src/index.ts` (внешним плагинам больше не нужно дублировать контракт).
- **Живой reload (фаза 4):** `AgentPlugin.onUnload?(ctx)` — освободить ресурсы при выгрузке
  (без него перезагрузка течёт сокетами: `examples/plugins/web-ui` поднимает HTTP-сервер в
  `onSessionStart`). Порядок `reloadFromDir`: **выгрузка → сброс кэша модулей → чтение**
  (иначе старый и новый экземпляр живут вместе, а дедуп по имени выкидывает новый).
  `PluginManager` владеет своими каталогами (`setSourceDirs` на bootstrap) — CLI, REPL и веф
  зовут `reload()` и не знают про пути. Поверхности: `mma plugins reload`, `/plugins reload`,
  `POST /api/reload/plugins` (отдельное пространство действий: `reload` — допустимое имя
  плагина, и exact-first сделал бы его невыключаемым), кнопка в Settings → Plugins.
- **Тули от плагинов (фаза 5):** `AgentPlugin.getToolDefinitions?()`; `plugins/tools.ts` — санитизация
  имени в `plugin__<плагин>__<тул>` (как `mcp__<server>__<tool>`), авто-тег `plugin:<name>`,
  `alwaysOn: true` по умолчанию, заполнение `provides.tools`; конфликт имени с ядром/другим
  плагином, мусор в определении, дубль после санитизации или throw в методе **отбрасывают весь
  вклад** плагина (ворн в лог + `getToolConflicts()` → `mma plugins show`), хуки остаются живы.
  `ToolRegistry.upsert/unregister` (`register` по-прежнему кидает).
- **Черновики capabilities (фаза 6):** `.mma/plugins/drafts/<name>.ts` + маркер согласия
  `.mma/plugins/.drafts-approved` (**вне** каталога — иначе скан плагинов съел бы маркер;
  проектный, а не глобальный). Каталог без маркера **не читается вообще** — инертность по
  умолчанию, а не «спросим при старте»: в headless вопрос некому задать, а молча грузить
  нельзя. Тул `define_capability` (`tags:["meta"]`, `alwaysOn:false`) пишет черновик, показывает
  **полный код** и спрашивает consent через `askUser` (`ctx.promptIO`); после «allow» —
  `draftHost.reloadDrafts()` (живая регистрация, доезжает и до открытых вкладок веба).
  Права (`permissions`) обязательны — иначе модальное окно врёт. LRU-лимит `plugins.maxDrafts`
  (10). Хост черновиков — `createDraftHost` (`plugins/draft-host.ts`), в контекст тулов
  прокидывается узким `ToolContext.pluginDrafts` (main — `session-phase.ts`, раннеры —
  `session-runner-scope.ts`). `mma plugins drafts [approve|revoke]`; неодобренные черновики дают
  warn при старте (`plugin.drafts_pending`).
- **Промпт-блок `[PLUGIN CAPABILITIES]`** (`plugins/capabilities-block.ts`, в
  `collectDynamicPromptBlocks`): перечисляет тулы плагинов + упоминает `define_capability`;
  **не добавляется** при сужении набора дочерним allowlist'ом (онбординг) — там тул недоступен.
- **Клоны реестра (фаза 5):** набор реестров держит `PluginManager`
  (`attachToolRegistry`/`detachToolRegistry`; главный — `modules-phase.ts`, раннер — сразу после
  `buildRunnerRegistry`), per-session менеджеры делят **объект-гейт** deny-list с главным
  (`shareGateWith`): мутация на месте + `gate.version` (кэш записей) + `syncGatePeers` (одна
  смена чинит все реестры гейта). Остановка раннера зовёт `runner.dispose()` →
  `detachToolRegistry`, иначе менеджер держит мёртвый реестр. Владелец тула берётся **из тега**
  `plugin:<name>` в определении (клоны `buildRunnerRegistry` приходят без записи о владельце —
  иначе вклад плагина отбраковывался как коллизия с ядром, а reload не обновлял тул).
  Перезагрузка доезжает до живых вкладок: главный (`followsGate === false`) рассылает
  `adoptPlugin`/`forgetPlugin` менеджерам своего гейта.
- **Контракт результата тула плагина** (`wrapPluginHandler`): отсутствие `success` = успех,
  нестроковый `output` приводится к строке, определение без `handler` отклоняется при регистрации
  с внятным ворном (иначе падение в рантайме `tool.handler is not a function`).
- **`require`-кэш проверен экспериментом:** сброс работает под Bun для `.ts` и `.js`, под Node
  только для `.js` (transpile кэшируется отдельно). Поэтому `ReloadReport.staleTs` — число
  `.ts`-плагинов со старым кодом, и UI/CLI **говорят об этом явно**, а не рапортуют об успехе.
- **Навыки:** `SkillsModule.reloadSources()` мутирует инстанс **на месте** — `load_skill` замкнул
  модуль при построении реестра, per-session раннеры держат тот же объект. Навык, написанный
  агентом, виден без рестарта.
- **Разбиение модуля:** диспатчер хуков вынесен в `plugins/dispatch.ts` (`manager.ts` уже был
  316 строк). Регистр → `records.ts` / `tools.ts` / `reload.ts`.
- **UI:** иконки вкладок заменены на читаемые в 17px (`layout-grid`/`code`/`plug` вместо
  плотных `map`/`stethoscope`/`puzzle`); автор плагина — акцентным цветом, версия dim; ховер
  строки. **Попутно исправлен общий баг:** `body.light .toggle` перебивал `.toggle.on` по
  специфичности — в светлой теме все тумблеры выглядели выключенными (включая настройки).
- **Честные ограничения (зафиксированы в доках и UI):** disable ≠ sandbox (модуль уже
  `require`-нут, код верхнего уровня уже выполнился); `permissions` — декларация для показа, а не
  enforcement. Настоящая изоляция/доверие — открытый P1 в
  `docs/specs/2026-09-28-production-readiness-design.md`.
- **Тесты:** `tests/plugin-records.test.ts`, `tests/plugin-enabled.test.ts`,
  `tests/plugin-reload.test.ts`, `tests/plugin-tools.test.ts`, `tests/plugin-drafts.test.ts`,
  `tests/skills-reload.test.ts`,
  `tests/plugin-loader.test.ts`, `tests/tools/registry-upsert.test.ts`,
  `tests/webui-plugins-api.test.ts`, `tests/webui-plugins-dom.test.ts`, guard в
  `tests/webui-assets.test.ts`, e2e `tests/e2e/web-plugins.e2e-test.ts`.
- **Побочно:** `subdialog.ts` теперь резолвит узлы оверлея лениво, а не на уровне модуля
  (захват на импорте молча no-op'ился, если оверлея ещё нет в DOM).

### Plugin Draft Quality (2.29.1)

Спека: [docs/specs/2026-10-07-plugin-draft-quality-design.md](./docs/specs/2026-10-07-plugin-draft-quality-design.md);
план: [docs/plans/2026-10-07-plugin-draft-quality.md](./docs/plans/2026-10-07-plugin-draft-quality.md).
Черновики `define_capability` (код, который пишет малая модель) теперь проходят
quality-gate и выглядят аккуратно.

- **Синтаксис до записи** (`src/modules/plugins/drafts.ts`): `validateDraftCode`
  парсит тело хендлера через `Bun.Transpiler` (обёртка `async (ctx,args)=>{…}`,
  без исполнения; вне Bun — skip). `validateDraftSpec` отклоняет битый код с
  «code has a syntax error: …» до записи файла.
- **Нормализация** (`normalizeDraftCode`, `renderDraft`): CRLF→LF, dedent, ≤1
  пустая строка, trim EOL, финальный `\n`, индент тела 2 пробела — без внешнего
  форматтера (prettier/biome не тащим в рантайм-зависимости).
- **Обратная связь при провале загрузки**: `DraftHost.lastError(name)` читает
  `PluginManager.getFailures()`; `define_capability` при `reloadDrafts().failed>0`
  возвращает `success:false` + `draft.capability_load_failed` (текст ошибки),
  вызывает `host.remove(name)` (битый одобренный черновик не остаётся), модель
  чинит и повторяет. `mma plugins drafts approve` печатает причины провала.
- **Контракт в описании тула**: хендлер возвращает `{ output, success? }`,
  доступны `ctx`/`args`, без импортов/топ-левел кода.
- **Инвариант сохранён**: черновик не исполняется до согласия (загрузка/импорт —
  только после approve).
- **Тесты**: `tests/plugin-drafts.test.ts` (синтаксис, нормализация, откат при
  провале загрузки).

#### Web Auto-Update & MMART Reaction (unreleased, ветка `feat/updater-web-mascot`)

Разбор: «перестало работать автообновление». Два независимых дефекта. Первый — не баг:
локальный `package.json` был `2.37.0`, npm `latest` — `2.36.0`, поэтому `semverGt()`
честно возвращал «апдейта нет» (система не предлагает обновление назад). Второй —
настоящий: в вебе автообновление **никогда не работало**, а панель настроек это
скрывала. Спека: [docs/specs/2026-10-09-updater-web-design.md](./docs/specs/2026-10-09-updater-web-design.md).

- **Причина мёртвого веба:** `runWeb` идёт с `exitOnComplete=true`
  (`web-command.ts:65`), а `main.ts:280` читал `exitOnComplete ? undefined :
  startAutoUpdate(config)` — модуль не создавался. При этом все четыре `updater.*`
  тумблера рендерились в панели (Advanced → Service) и не делали **ничего**.
  Флаг `exitOnComplete` решает, кому принадлежит stdin; апдейтер в stdin не лезет
  (`fetch` + `execFile`) — связь была ложной. Убрана; `mma serve` выигрывает тем же.
- **Одна точка сборки:** `createUpdater({config, entryPath, logger, onNotice})`
  (`src/modules/updater/factory.ts`) — dev-гард `isDevEntryPath`, чтение версии и
  проброс событий одинаковы для терминала и веба. `cli/main.ts` → `busLogger()`,
  `cli/web-command.ts` → `startWebUpdater()` (гасится `updater?.stop()` на shutdown).
- **SSE `update`:** `{type:"update", ts, phase: available|installed|failed, current,
  latest?, error?}` — глобальное событие без `sessionId` (как `index`/`files`).
  Только фазы апдейта; недоступный реестр — лог, не новость для пользователя.
- **Постоянная половина — в снапшоте:** `WebUiState.updateAvailable` →
  `HostStateSnapshot.updateAvailable` (`core/host.ts`, `webui/host-state.ts`) → чип
  `↑ <latest>` в `footer.ts` рядом с `mma <version>`. По правилу event-sourced state:
  постоянный факт едет в `state` (переживает реконнект и новую вкладку), а SSE
  `update` нужен маскоту для реакции в момент обнаружения.
- **Реакция MMART:** новое состояние лица `update` (`c-ok st-update happy`) — медленный
  подъём с зелёной искрой. Без `track`/`poke`: маскот не гонится за курсором и не
  здоровается поверх чипа. `loaderStateFor` **не** относит `update` к фоновым
  broadcast'ам (`usage`/`state`/`config`/`files`/`sessions`/`plugins`/`log` → `idle`).
  `app.ts` ловит `update` → `faceEvent("update")` → возврат в `idle` через 4 с;
  `phase:"failed"` → `error`.
- **Удалён `updater.checkOnStart`** — единственный флаг без читателя (21 упоминание,
  0 чтений). `enabled:false` = не проверять, `intervalMs:0` = одна проверка; оба
  состояния, которые он мог выразить, уже написаны иначе. Вычищен из `types`,
  `defaults`, `registry-extra`, `main.ts`, `controls.ts`, обоих i18n и 3 фикстур;
  гварды в `tests/webui-config-extra.test.ts` не дают ему вернуться. Старый ключ в
  `~/.mma/updater.json` остаётся, но игнорируется. Попутно исправлены доки
  (`modules.md`, `versioning.md`, `mma-features-overview.md`), где он и `autoInstall`
  были описаны как `default true`.
- **`autoInstall` остался `false`** + новый ключ `updater.auto_install_hint`
  (en+ru): сообщение «доступно обновление» теперь подсказывает
  `/config updater.autoInstall true`, а не выглядит тупиком.
- **Тесты:** `tests/updater-web-notify.test.ts` (фабрика: dev-гард, реестр, тишина на
  офлайне; контракт веб-обвязки), `tests/updater-module.test.ts` (+наблюдатель фаз и
  подсказка), `tests/webui-workspace-footer.test.ts` (чип, coexistence с MoE, снятие),
  `tests/webui-loader.test.ts` (состояние `update` не фоновый broadcast), гвард в
  `tests/webui-config-extra.test.ts`.

### MoE Indicator (2.30.0)

Спека: [docs/specs/2026-10-08-moe-indicator-design.md](./docs/specs/2026-10-08-moe-indicator-design.md).
Пользователь видит, что ход ведёт оркестрация: одна строка в чате на ход + чип
режима в футере `mma web`.

- **Строки чата** (`src/core/agent-moe.ts`): `moe.started` (`◇ MoE · plan of N
  steps`) печатается **один раз за ход** после валидного плана (re-plan циклы
  молчат), `moe.finished` / `moe.finished_partial` / `moe.finished_error` — на
  выходе (`verifyResult.type === "final"`, `partialFailure`, обрыв слияния).
  Вперёд идут **не через `status()`**, а напрямую в `onMeta` — то есть ungate
  от `ui.verbose`; `replan`/`plan_autofixed`/`scope_*` остались verbose-only.
  `moe.executing` и `moe.planning` удалены (планирование покрывает спиннер
  thinking), emoji в `moe.*` заменены на глифы STYLE.md.
- **Флаг «MoE ведёт ход»**: опция `runWithMoE({ onMoEState })` + деп
  `AgentDeps.onMoEState` и сеттер `Agent.setMoEStateListener` (веб подписывает
  уже собранного раннера). `true` — после валидного плана, `false` — в
  `finally` обёртки `runWithMoE` (тело вынесено в `runMoECycles`), поэтому
  фолбэк, ошибка и Esc гасят флаг. Это **факт, а не `moe.enabled`**.
- **Бейдж веба**: `HostStateSnapshot.moeActive` ← `state.moeSessions[sid]`
  (`activeMoe(state, sessionId)`, чистится при удалении сессии), едет в
  `pushState` — нового SSE-типа нет (правило event-sourced state). Футер —
  листовой `assets/js/footer.ts` (`renderFooter(el, input, make)`): путь с
  ellipsis, чип `MoE`, версия справа. Терминал бейджа не имеет — там строка чата.
- **Тесты:** `tests/core/moe-indicator.test.ts` (9 кейсов: ungate, один
  announce на цикл, verbose-only шум, частичный/оборванный итог, сброс флага на
  фолбэке/планировании/аборте), `tests/webui-workspace-footer.test.ts` (чип),
  `tests/webui-usage.test.ts` (`moeActive` в снапшоте).

### Harness Infra-Failure Honesty (2.33.0)

Разбор живой сессии `ses_muz7sg1l_0ankgu` (`mma`, LM Studio, MoE): ход умер
молча — ни ответа, ни причины. Восемь первопричинных дефектов харнесса (не модели).

- **Текст ошибки провайдера** (`src/llm/provider-error.ts`,
  `extractProviderErrorText`): LM Studio шлёт `{"error": {message, type, param}}`,
  и `String(parsed.error)` давал `[object Object]` — причина терялась в логе, в
  retry-классификации и в результате сабтаска. Разбирает `message`, вложенный
  `error`, массивы; фолбэк — компактный JSON. Места: mid-stream
  (`openai-compat.ts`) и non-stream 200-ответ с `error`.
- **Transient vs infra** (`modules/execution/transient-error.ts`): `isTransientError`
  теперь ловит mid-stream, `engine protocol`, `failed to load model`, `stream
  stalled`/`no data for Nms` (раньше не матчил ничего → падение с первой попытки
  без backoff). Новая `isInfraError` отделяет бэкенд/транспорт от задачи.
- **Re-plan только по контентным фейлам** (`core/agent-moe.ts`): если ВСЕ
  упавшие сабтаски инфраструктурные, верификатор не зовётся — честный
  `partialFailure` с реальной причиной (`moe.infra_failure`), событие
  `moe_verify {decision:"infra_failure"}`. Контентные фейлы по-прежнему идут в
  `verifyAndMerge` c `failedSubtaskIds`; `VERIFY_SYSTEM_PROMPT` запрещает
  выдумывать причину и репланить инфраструктуру.
- **Модели экспертов** (`modules/execution/expert-model-check.ts`): раз за ход
  `experts[tag].model` сверяется со списком моделей активного провайдера
  (`listModels`, 5s-таймаут); неизвестная → фолбэк на активную + `logger.warn`
  (тег, плохая модель, доступные). Живой конфиг НЕ мутируется — оркестратор,
  валидатор и исполнитель получают копию (`applyExpertModelCheck`). Кей был:
  у экспертов `qwen/qwen3.5-9b`, активна `qwen3.8-9b-distill` → 3 попытки ×
  `Failed to load model` на сабтаск.
- **Параллелизм по бэкенду** (`modules/execution/moe-parallelism.ts`,
  `moe.parallelSubtasks` — реестр, `/config`, web Settings → Agent → MoE):
  локальный однодвижковый (тип `lmstudio`/`ollama` или loopback-хост) → 1
  подзадача за раз; иначе `security.rateLimits.maxParallelTasks`; явное
  значение всегда выигрывает, `0` = авто.
- **Причина в логе** (`moe-executor.ts` → `moe_subtask {error, infra}`;
  `SessionLogger.logMoE` берёт `detail → explanation → error → summary` в
  `content`): раньше в `session.jsonl` попадало только `Failed: task-2`, и
  разборчик/верификатор причину выдумывал. `renderMoEResults` показывает
  первую строку ошибки и в итоговом тексте хода.
- **Оборванный ход оставляет след**: `runWithMoE` ловит throw и пишет
  `moe_verify {decision:"aborted"|"error", explanation}` (только если MoE уже
  стартовал). Плюс `SessionManager.touch()` в `emitTurnEnd` — `updatedAt`
  двигает и ход без сообщений.
- **Probe ↔ meta** (`applyProbedContext` принял `sessionManager`): применение
  пробного окна синхронизирует `meta.contextWindow`/`model`; иначе 262144 в
  конфиге и 65536 в `meta.json`/`session_start` (кей сессии).
- **NotifyPlugin**: одна строка `debug` с id сессии вместо `info` без id
  (14 одинаковых строк `Session ended` на один ход).

### Web Answer Typography (2.34.0)

Финальный ответ в web читался как плотная «каша» и местами сырым текстом. Две причины,
обе в рендере ответа.

- **GFM, который не парсит `smd.js`** (`src/modules/webui/assets/js/md-normalize.ts`, `md.ts`):
  таблицы без крайних `|`, списки `1)`, заголовки `##X` без пробела теперь нормализуются
  до парсинга. `MdNormalizer` потоковый (одна строка lookahead под delimiter таблицы), поэтому
  живой стрим и история дают идентичный результат; код-фенсы не трогаются.
- **Мягкие переносы** (`styles.css`): `.md p` без `white-space: pre-wrap` — проза течёт
  пробелами по CommonMark, а не рагу из коротких строк.
- **Типографика** (`styles.css`): `.md` line-height 1.62; абзац `4→9px`; шкала заголовков
  `1.5/1.28/1.12em` с верхним отступом 18px; списки `li 3px`, отступ 24px; паддинг ячеек
  таблицы + линия под шапкой; отступы `hr`/`blockquote`/код-блоков. Первый/последний
  дочерний без внешних отступов.
- Тесты: `tests/webui-md-normalize.test.ts`, `tests/webui-md-render.test.ts`, guard в
  `tests/webui-assets.test.ts`.

### Session UI Hydration (2.33.1)

Разбор живой сессии `ses_muzbb045_9v1r4t` (`mma web`): план не появлялся в сайдбаре,
в ленте не было первого сообщения, имя сессии не доезжало до открытой вкладки. Три
дефекта харнесса вокруг per-session состояния.

- **Слот плана больше не стирается чужим переключением** (`ExecutionModule.switchSession`,
  `src/modules/execution/module.ts`): общий web-модуль UI (трекер null) на каждом
  `switchSession`/create чистил слот уходящей сессии — а план этой сессии принадлежал её
  per-session раннеру. Возврат/перезагрузка → сайдбар пуст. Теперь уходящий слот чистится
  только когда у инстанса есть свой трекер; опустение фиксирует владелец через `flushSessionPlan`.
- **Мутации плана персистятся и в слот сессии** (`persistPlan`, `plan-actions.ts`,
  `plan-tool.ts`): `plan_step`/`plan update`/`todo` и kind-switch писали только глобальный
  `active.json`; после reload сайдбар показывал устаревшие статусы. `PlanToolDeps.persistPlan`
  зеркалит мутацию в слот.
- **Авто-открытая сессия гидрирует транскрипт** (`assets/app.ts`, `assets/js/state-sync.ts`):
  активная сессия открывалась как «live» (`historyLoaded=true`), история не тянулась — после
  reload посреди хода в ленте только SSE-хвост, без первого сообщения. `shouldHydrateAutoOpen`
  (чистая) — сессия с сообщениями грузит историю, новая остаётся live.
- **Переименование доезжает до UI** (`SessionManager.onRename`, `webui/module.ts`): авто-имя и
  LLM-заголовок меняли только `meta.json`; вкладка держала старое имя, а LLM-заголовок не
  показывался вообще. Слушатель (общий с pinned-сиблингами раннеров) шлёт `sessions` + `state`.

### Closing the Last Tab Resets the Session (unreleased)

Закрытие последней вкладки `mma web` оставляло серверно-активную сессию и её контекст
«висеть»: клиент сбрасывал только ленту, `session.activeSessionId` и сайдбар держали
закрытую сессию, следующий ход/перезагрузка уходили в неё, и всё расходилось.

- **Клиент** (`assets/js/session/tabs.ts`): `closeTab` при переключении на соседнюю вкладку
  синхронит `session.activeSessionId`/сайдбар/`ensureTabState` и шлёт `activate` (раньше
  переключение не доезжало вовсе); при закрытии **последней** — `resetToEmpty()`: чистка
  session-слайса + `hooks.renderActive()` (пустой сайдбар/план/usage) + `POST
  /api/sessions/deactivate`. `hooks.renderActive` регистрирует `app.ts`.
- **Сервер** (`SessionManager.clearActive()`, `POST /api/sessions/deactivate`,
  `webui/session/sessions-api.ts`): сброс активной сессии, `execModule.switchSession(null)`,
  выгрузка **простаивающего** раннера (`pool.drop`, контекст не висит; бегущую/queued не
  трогаем), `sessions` + `state` бродкаст. Идемпотентно.
- **Пустой экран = «новый чат»** (`assets/js/session/composer.ts`): `send()` без активной
  сессионной вкладки сначала поднимает свежую сессию (`await deps.newChatTab()`), иначе ход
  ушёл бы в закрытую сессию.

### Agent Service API v1 (2.35.0)

Долгоживущий HTTP-сервис `mma serve` (`src/modules/service/`) — публичный
версионируемый контракт для внешних систем поверх ядра. Не трогает петлю/REPL/
`mma web`. Спека: [docs/specs/2026-10-08-agent-service-api-design.md](./docs/specs/2026-10-08-agent-service-api-design.md);
план: [docs/plans/2026-10-08-agent-service-api.md](./docs/plans/2026-10-08-agent-service-api.md);
reference: [docs/agents/service-api.md](./docs/agents/service-api.md);
user guide: [docs/serve-mode.md](./docs/serve-mode.md) (README → «Service mode (`mma serve`)»).

- **Изоляция = процесс (silo):** `1 тенант = 1 процесс` со своим `MMA_CONFIG_DIR`
  и workspace; внутрипроцессные синглтоны → per-tenant без рефактора ядра.
- **Переиспользование, не рефактор webui:** `bootstrap().spawnSessionRunner`,
  `RunPool` (`src/modules/webui/session/session-pool.ts`), `SessionManager`,
  `Agent`. `RunPool` получил аддитивный `maxQueue` (дефолт прежний) — контракт
  `mma web` не изменился.
- **Задача = ход над сессией.** `job` (автономная) / `interactive` (вопросы через
  SSE + `POST /v1/tasks/:jobId/answer`). Реестр задач in-memory (`TaskRegistry`):
  жизненный цикл, `wait:true`, `Idempotency-Key`, retention, webhook.
- **Authz job-режима:** `toolAllowlist` применяется **строго** к
  `ToolContext.toolAllowlist` на время хода (теги/`alwaysOn` не обходят) и
  восстанавливается после; попытка интерактивного/вне-allowlist тула = `failed`
  `…/tool-forbidden` (`runtime/run-task.ts`, `api/tasks-api.ts`). Interactive —
  без ограничения.
- **Tenant-контекст** из auth-заголовков `X-Mma-Tenant/Principal/Run/Tier/Scopes`
  (не из тела) → запись `service_task` в `session.jsonl` (`tenantId/principalId/runId/jobId`);
  тип добавлен в `SessionLogEntry` и `log-api` ALLOWED_TYPES (§10.2/§11).
- **Эндпоинты:** `/v1/sessions` CRUD, `/v1/sessions/:id/tasks`, `/v1/tasks/:jobId`
  (+`/cancel`, `/answer`), `/v1/sessions/:id/events` (SSE), `/v1/health`,
  `/v1/ready`. Ошибки — RFC 9457 problem+json со стабильными `type`-URI.
- **SSE envelope** (`runtime/envelope.ts`): `{v:1,seq,ts,type,sessionId,taskId,data}`,
  монотонный `seq` на сессию, resume `Last-Event-ID`/`?since=` из in-memory
  буфера, keep-alive `: ping`, `X-Accel-Buffering: no`; закрытие потока отменяет
  только interactive-задачу.
- **Structured output** (`runtime/output.ts`): `output.schema`, strict-подмножество
  JSON Schema, рантайм-валидация, один retry, затем `output-invalid`.
- **Webhook** (`runtime/webhook.ts`): HMAC-SHA256 по `timestamp.body`, стабильный
  `X-Mma-Event-Id`, backoff-ретраи; pull — источник правды.
- **Конфиг `service.*`** (порт/хост/токен/retention/idempotency/syncWait/limits/
  webhookSecret) → `config/service.json`, `/config`, web Settings → Network;
  env `MMA_SERVICE_PORT|HOST|TOKEN`.
- **Сессии:** опц. `SessionMeta.externalRef` (backward compatible).
- **Тесты:** `tests/service/*` (HTTP-клиент на `node:http`, чтобы не ловить
  протечку `global.fetch` из других suites).

### Self-describing service contract (2.37.0)

Контракт `mma serve` объявляет себя сам: `GET /v1/openapi.json` (OpenAPI 3.1) и
`GET /v1/docs` (человеческая HTML-страница). Оба печатаются при старте
(`cli.serve_docs`) и лежат в exempt-списке `OPEN_PATHS` (`service/server.ts`)
рядом с `/v1/health` и `/v1/ready` — описание публичного API, не данные тенанта.

- **Единый источник правды** — таблица `OPERATIONS`
  (`src/modules/service/openapi/operations.ts`): из неё собираются и OpenAPI
  документ (`openapi/document.ts`, `schemas.ts` → `components.schemas`), и
  страница (`openapi/docs-page.ts`, самодостаточный HTML без CDN — агент часто
  офлайн, Swagger UI из сети не годится). Guard-тест
  `tests/service/openapi.test.ts` сверяет таблицу с реальными маршрутами: новый
  эндпоинт без строки в `OPERATIONS` ломает тест.
- **Auth в спеке:** корень `security: [{bearerAuth: []}]` при заданном токене,
  открытые маршруты снимают его явным `security: []`; без токена корень пуст.
- **Хендлеры:** `api/docs-api.ts` (тонкие: сборка + отправка), маршруты — в
  `http/routes.ts` `API_ROUTES` (правило #17).
- **Версия:** `info.version = 1.0.0+mma-<runtime version>` — спека не может
  разойтись с рантаймом, `x-runtime` несёт `authRequired` и схему изоляции.

### MMART — the Web Mascot (Loader Faces, unreleased)

Спека: [docs/specs/2026-10-08-loader-webui-design.md](./docs/specs/2026-10-08-loader-webui-design.md).
Агент получил «лицо» (squircle + анимированные глаза), одно на все поверхности.
**Маскот называется MMART** (MMA + art) — экспорт `MMART_NAME` в `loader.ts`.

- **Компонент** `src/modules/webui/assets/js/loader.ts`: `createFace(state,size)`,
  `setFaceState`, чистая `loaderStateFor(signal)` / `toolState(name)`, `initCursor()`
  (слежение за курсором + наклон тела для `.track`, клик → моргание для `.poke`).
  Лицо всегда несёт все доп-элементы (`.orb/.keys/.grow/.fly/.dust/.q/.spark/.star`);
  видимость решает CSS по `.st-*`.
- **18 состояний** `.st-*` + цвета `.c-*` (recon/mutate/exec/ok/warn/err/active/dim)
  в `styles.css` (компонент). Классы состояний и цвета берутся из дизайн-демо
  `tmp/loader/app.html`.
- **Boot splash** `#bootSplash` в `index.html` — одно лицо состояния `st-load`
  (пробуждение: глаза закрыты→открываются) + прогресс; `app.ts` скрывает его по
  завершении `boot()` (и при передаче экрана мастеру setup). `initCursor()`
  вызывается на старте boot. У `.mdl` мягкая тень (`box-shadow`, отдельная для
  light-темы).
- **Приветствие по клику** — клик **непосредственно по лицу** (или его частям,
  `.closest(".mdl.poke")`) поднимает локализованное облачко `web.loader.greet`
  («Привет! Я MMART» / «Hi! I'm MMART») на 2.2с; повторный клик перезапускает
  таймер, а не штабелирует (`WeakMap` таймеров в `loader.ts`). **Любой другой клик
  по странице только моргает** — приветствие не пасхалка всего документа.
  Лицо в работе (не `.poke`) не приветствует. Текст инжектится через
  `setGreetResolver(() => t("web.loader.greet"))` из `app.ts` (в `applyStaticI18n`,
  поэтому переживает смену локали) — i18n в `loader.ts` не импортируется,
  иначе ломается импорт-тайм в тестах (i18n → api трогает `location`).
  Размер шрифта облачка имеет нижний порог (`max(12px, …)`): на маленьком лице
  (22px) масштаб давал нечитаемые 4.6px.
- **Полное покрытие тулов** в `TOOL_STATE` — у каждого поведенческого класса свой
  стейт, а не молчаливый `run`: `approve`/`question` → `ask`, `web_browse` → `web`,
  `load_skill`/`session_info` → `read`, `search_history` → `find`,
  `define_capability`/`remember` → `create`, `set_thinking` → `think`,
  `meet_done` → `done`.
- **SSE-реакции** (`app.ts`, рядом с `faceEvent`): `retract` → `error` (отозванный
  черновик = забракованное утверждение), `index` → `find` (переиндексация),
  `setup_done` → `done`. Фоновые бродкасты (`usage`/`state`/`config`/`files`/
  `sessions`/`plugins`/`log`) в `loaderStateFor` отображаются в `idle`, но
  **сознательно не пробрасываются в `faceEvent`** — это не активность агента,
  лицо не должно дёргаться на них.
- **Лента** — `feed/core.ts showBusy()` строит `.busy` с лицом (`think`) вместо `✦`.
- **Activity rail** — без лица: возвращён `✦`-лейбл (фаза/счётчики), состояние
  показывает постоянное лицо в композере.
- **Композер** — постоянное лицо в строке селекторов (`#composerFace`), всегда
  отражает текущее состояние; события обновляют его в `app.ts` (`faceEvent`),
  между ходами возвращается в idle (следит за курсором). Размеры rail/композера —
  30px, у `.eye` гарантированы `min-width/height` и `gap`.
- **Setup** — `setup.ts setMsg(kind:"", …)` показывает лицо при test/scan/model-load.
- **Сайдбар** — `.sb-loadface` в `#pane-session` показывается при `.sb.sb-loading`
  (`setSessionLoading`), секции при этом приглушены.
- **Trace** — `.trc-face` в `#pane-trace`: лицо сессии (`initTraceFace`), состояние
  по событиям (`traceFaceFor` в `sidebarTraceEvent`), возврат в idle по
  `sidebarBusy(false)`.
- **i18n**: `web.loader.boot`, `web.loader.greet` (en+ru). Тест:
  `tests/webui-loader.test.ts` (маппинг, покрытие тулов, фоновые бродкасты,
  DOM-структура, `#bootSplash`, приветствие только по клику на лицо).

### Web Parallel-Turn & Settings Consistency (2.35.2)

Разбор живой сессии `mma web` (две вкладки, параллельные ходы) + ревизия: стрим
фоновой сессии протекал в активную вкладку, настройки показывали устаревшее
значение после команд, прерванный ход рапортовал `ok`, probe сравнивался не с
тем окном, открытые вкладки терялись при перезагрузке.

- **Per-feed стрим-состояние** (`assets/js/core/store/feed.ts`, `feed/stream.ts`,
  `feed/turn.ts`, `feed/core.ts`): `curText`/`curMd`/`curThink`/`turnMd`/`turnRoots`/
  `run*`/`pendingArgs`/`toolNodes`/`busyTimer` больше не глобальные — переехали в
  `FeedStreamState`, привязанное к фиду вкладки (`streamStateFor(feed)`), само
  `feed` (срез) держит только дедуп-сигнатуры сайдбара. `finishMd`/`finishThink`/
  `flushRun`/`resetTurnText` принимают фид. `pendingArgs`/`toolNodes` — на фид, так
  что коллизии `toolCallId` (`t1` в каждом раннере) между сессиями не путают узлы.
  F5-guard: `tests/webui-feed-isolation-dom.test.ts`.
- **`config` SSE-событие** (`chat/commands-shared.ts`, `settings/config-api.ts`,
  `assets/app.ts`): успешная запись конфига (команда и REST) шлёт
  `broadcast({type:"config"})`; клиент на него зовёт `loadConfig()` → панель
  настроек и селекторы обновляются сразу, а не после перезагрузки. Тест
  `tests/webui-config-event.test.ts`.
- **Прерванный ход** (`core/agent.ts`, `core/types.ts`, `session/run-agent.ts`):
  `AgentResult.interrupted` выставляется при `shutdown`/AbortError и едет в
  `turn_end`; `success` для оборванного хода — `false`, лента рисует `stopped`,
  не `turn end · ok`. Тест в `tests/core/agent-turn-end.test.ts`.
- **Probe-метка** (`assets/js/feed/sidebar.ts`): «configured» берёт
  `h.contextWindow` (истинное окно), а не `h.contextLimit` (history-бюджет ~75%) —
  иначе конфиг 1000K читался как «750.0K configured». Guard в
  `tests/webui-assets.test.ts`.
- **Персистентность вкладок** (`assets/js/session/tabs.ts`, `assets/app.ts`):
  список открытых session-вкладок и активная хранятся в `localStorage`
  (`mma-open-tabs`, `readSavedTabs`/`persistTabs`) и восстанавливаются на boot
  **до** `refresh()` (`restoreTabs`; `?session=` в URL выигрывает как активная);
  `openTab(id, name, kind, server, activate)` с `activate=false` создаёт фоновую
  вкладку без подмены активной.

### Frontend Seams — готовые швы фронтендов (unreleased, `refactor/frontend-core-seams` → master)

Разбор для TUI показал: фронтенд-независимого ядра достаточно, но три шва
упирались в терминал. Все три закрыты; поведение пользователя не менялось.
**TUI по итогам разбора отложен** (спека `docs/specs/2026-10-10-tui-frontend-design.md`,
§0): без постоянной панели он = REPL в альт-экране, что отнимает scrollback
и не окупается. Но сами швы полезны независимо — `mma serve` импортировал
проекцию состояния из веб-модуля, и это теперь исправлено. Спека TUI — не
реализация, а разбор для возможного пересмотра.

- **Проекция состояния в core** (`src/core/host-state.ts`): `buildHostState`/
  `captureUsage`/`liveContextUsage`/`planEventFor`/`UsageSnapshot` лежали в
  `src/modules/webui/host-state.ts`, хотя `mma serve` уже импортировал
  `planEventFor` оттуда — структурное подмножество веб-бэкенда как общий
  контракт. Теперь ядро в `core`; `webui/host-state.ts` — тонкая обвязка
  (`WebIndexer`/`WebLsp` + web-only проба `i18nStale`, в core флаг опционален).
- **`ReplContext` разделён** (`src/cli/command-context.ts`): интерфейс на 20
  членов смешивал фронтендонезависимые сервисы с терминальным вводом-выводом
  (`rl: LineInput`, `output: OutputChannel`), из-за чего TUI не мог переиспользовать
  реестр команд. Теперь `CommandServices` (без IO) + `CommandOutput`
  (`writeLine`/`clearScreen` обязательны; `writeOverlay` и тумблеры verbose —
  опциональны) + `CommandInput` (`withInput`/`question`/`confirm`).
  `ReplContext` — алиас. `/wizard` и `/config reset --all` идут через
  `ctx.input`; эксклюзивность ввода переехала из команды в терминальный адаптер
  (`createCommandInput(rl, ask, exclusive)`), поведение визарда сохранено
  (`inputLocked`). `Spinner` принимает `SpinnerSink` (`writeOverlay`), а не канал.
- **Декларативный каталог команд** (`src/core/commands/{catalog,spec}.ts`):
  три описания расходились молча — таблица `COMMAND_GROUPS` (29 строк, синхронизировалась
  вручную), регистрации REPL и список `HELP` в вебе. Теперь 29 команд — данные;
  `CommandRegistry` приклеивает действия фронтенда через `bind()`; `isAvailable`
  фильтрует по поверхности, **без `surfaces` доступны terminal + tui** (иначе
  перечисление `"tui"` 29 раз гарантировало бы тихую потерю команды);
  `webName` фиксирует единственное расхождение имён (`/sessions` ↔ `/session`).
  **Действия НЕ унифицированы** намеренно: терминал печатает ANSI, веб — plain
  в SSE; это работа адаптера `CommandOutput`, каталог отвечает только за «что есть».
  `/help` строится по каталогу, `COMMAND_GROUPS` удалена.
- **Сторожи:** `tests/core/command-catalog.test.ts` (каталог ↔ регистрации REPL в
  обе стороны; web-команды ↔ реальный веб-диспатчер; алиасы не коллизируют),
  `tests/cli/repl-help.test.ts` (видимый вывод `/help`),
  `tests/cli/command-context.test.ts` (поверхность для нового фронтенда).
  Сверка с вебом поймала три неверных записи при разработке.
- **Не сделано (осознанно):** унификация 29 хендлеров REPL с 14 веб-хендлерами —
  это переписывание вывода, а не шва; рендер TUI, ввод и компоновка — отдельная задача.

### Current Version: 2.37.0

Self-describing service contract (see the section above): `mma serve` serves its
own OpenAPI 3.1 document and human docs page from one `OPERATIONS` table.

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
