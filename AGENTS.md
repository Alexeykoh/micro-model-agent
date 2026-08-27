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

### Current Version: 0.56.4

### Changelog

Все изменения документируются в `CHANGELOG.md` (формат [Keep a Changelog](https://keepachangelog.com/)).

**Правило:** при каждом релизе (MINOR/PATCH) — добавляй запись в `CHANGELOG.md` в секцию `## [X.Y.Z] - YYYY-MM-DD`. Группируй по Added/Fixed/Changed/Removed. Пиши на английском, кратко и по существу. Формат ссылок: `**Module**: description`.

При публикации (`npm publish`) changelog автоматически попадает в пакет и виден пользователям при установке (`npm info micro-models-agent`).

### Commands by Version Bump

**MINOR** — new CLI/REPL commands, new tools, new modules, new config options, new security features

**PATCH** — bug fixes, i18n, docs, tests, performance, non-breaking dependency updates

**MAJOR** — removed/renamed commands, config schema changes, removed tools/modules, architecture rewrites
