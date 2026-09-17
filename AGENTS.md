# MMA v2 — Micro Models Agent

AI coding agent harness for small models (Qwen3.5-9B, 32K-64K context). Complete rewrite from MMA v1.

> **Design spec:** [docs/specs/2025-07-28-mma-v2-design.md](./docs/specs/2025-07-28-mma-v2-design.md) — architecture, modules, tools, CLI, config, data flow.

> **Literature:** [docs/literature.md](./docs/literature.md) — agent harness engineering best practices audit (Anthropic, OpenAI, LangChain, HuggingFace, deepset, Martin Fowler).

> **Этот файл должен периодически обновляться при изменениях в проекте.** При добавлении новых модулей, тулов, команд, изменении архитектуры или конфигурации — обнови соответствующий раздел ниже. AGENTS.md должен всегда отражать актуальное состояние проекта, чтобы агенты и разработчики имели достоверный контекст.

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

| Document | Description |
|----------|-------------|
| [architecture.md](./docs/agents/architecture.md) | Architecture, Security Module, LLM Provider Contract, Key Design Rules, Project Structure |
| [tools.md](./docs/agents/tools.md) | Question Tool, Browser Tool, Image Handling, Tool Set Narrowing, Process Management |
| [modules.md](./docs/agents/modules.md) | Session Management, Project Map, UI Rendering, Plugins, Context Budget, Cost Tracking, Auto-Update |
| [execution.md](./docs/agents/execution.md) | Execution Guarantees, Agent Loop States, Orchestrator, RLM-Inspired Features, Hallucination Detection, Migration Safety |
| [testing.md](./docs/agents/testing.md) | Agent Testing from Console, Small Model Observations, Model Certification |
| [versioning.md](./docs/agents/versioning.md) | Versioning Rules, Release Process, Version History |
| [changelog](./CHANGELOG.md) | Public changelog (included in npm package) |

## Quick Reference

### Agent Loop States

```
INIT → THINK → ACT → OBSERVE → OUTPUT → ERROR
```

### Context Budget

| contextWindow | System (10%) | Reserve (15%) | History (75%) |
|--------------|-------------|--------------|---------------|
| 32K          | 3K          | 5K           | 24K           |
| 64K          | 6K          | 10K          | 48K           |
| 128K         | 13K         | 19K          | 96K           |

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

- **Обрезание по completion-лимиту** — `max_tokens` (default 4096) шлётся всегда. Если модель уже стримила текст и упёрлась в `finish_reason: "length"`, провайдер теперь отдаёт non-fatal `warning`-чанк (`src/llm/openai-compat.ts`, стрим + non-stream), а агент рендерит его в чат (не попадает в текст ответа/контекст). Обрыв на tool_call/пустом ответе по-прежнему идёт recoverable-ошибкой. Ключ i18n: `error.llm_output_truncated`.
- **История сессии без обрезки** — `saveAssistantMessage` / `logToolResult` (`src/core/session-logger.ts`) пишут полный контент (раньше `slice(0, 500)`), чтобы `/resume` не терял прошлые ответы и tool-результаты. Бюджет контекста режет то, что уходит в LLM.

### Current Version: 0.63.3

### Changelog

Все изменения документируются в `CHANGELOG.md` (формат [Keep a Changelog](https://keepachangelog.com/)).

**Правило:** при каждом релизе (MINOR/PATCH) — добавляй запись в `CHANGELOG.md` в секцию `## [X.Y.Z] - YYYY-MM-DD`. Группируй по Added/Fixed/Changed/Removed. Пиши на английском, кратко и по существу. Формат ссылок: `**Module**: description`.

При публикации (`npm publish`) changelog автоматически попадает в пакет и виден пользователям при установке (`npm info micro-models-agent`).

### Commands by Version Bump

**MINOR** — new CLI/REPL commands, new tools, new modules, new config options, new security features

**PATCH** — bug fixes, i18n, docs, tests, performance, non-breaking dependency updates

**MAJOR** — removed/renamed commands, config schema changes, removed tools/modules, architecture rewrites
