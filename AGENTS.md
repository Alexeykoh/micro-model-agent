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

### Current Version: 0.61.0

### Changelog

Все изменения документируются в `CHANGELOG.md` (формат [Keep a Changelog](https://keepachangelog.com/)).

**Правило:** при каждом релизе (MINOR/PATCH) — добавляй запись в `CHANGELOG.md` в секцию `## [X.Y.Z] - YYYY-MM-DD`. Группируй по Added/Fixed/Changed/Removed. Пиши на английском, кратко и по существу. Формат ссылок: `**Module**: description`.

При публикации (`npm publish`) changelog автоматически попадает в пакет и виден пользователям при установке (`npm info micro-models-agent`).

### Commands by Version Bump

**MINOR** — new CLI/REPL commands, new tools, new modules, new config options, new security features

**PATCH** — bug fixes, i18n, docs, tests, performance, non-breaking dependency updates

**MAJOR** — removed/renamed commands, config schema changes, removed tools/modules, architecture rewrites
