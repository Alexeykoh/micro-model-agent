# MMA — Micro Models Agent v2

[![npm version](https://img.shields.io/npm/v/micro-models-agent)](https://www.npmjs.com/package/micro-models-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**MMA** — modular AI coding agent harness designed for **small local language models** (9B params, 32K–64K context). Runs on your laptop, no cloud API needed.

```bash
npm install -g micro-models-agent
mma "refactor the auth module to use JWT"
```

Built for and tested with [Qwen3.5-9B](https://qwen.readthedocs.io/) via LM Studio / Ollama / llama.cpp.

---

## Why MMA?

Most AI coding agents (Devin, Cursor, Copilot) depend on massive cloud models or expensive APIs. MMA is built differently:

- **Designed for 9B models** — optimized for Qwen3.5-9B running locally on consumer hardware
- **No cloud dependency** — works fully offline with any OpenAI-compatible backend
- **Survives small context windows** — sophisticated sliding-window compaction keeps 32K models productive
- **Catches hallucinations** — 3-stage validation pipeline catches the confabulations small models are prone to
- **Agent-Level MoE** — hierarchical task decomposition so small models handle complex multi-step work

---

## Features

- **6-state agent loop** (INIT → THINK → ACT → OBSERVE → OUTPUT → ERROR) — clean, predictable, debuggable
- **Context budget management** — dynamic per-model budget, sliding-window compaction with fact/decision/error extraction
- **Hallucination detection** — factual (file paths), consistency (decision reversals), confidence (short/repetitive responses)
- **Execution guarantees** — auto-planning via LLM (no keyword heuristics), stuck detection, off-track warnings, plan auto-advance
- **Agent-Level MoE** — Router + Expert sub-agents with filtered tools, isolated context, file scope, and topological parallel execution
- **20+ tools** — filesystem, shell, web search/fetch, browser (Playwright), planning, interaction, subagent, MCP, pipelines
- **13 modules** — skills, plugins, MCP client, pipelines, project indexer, persistent memory, context, sessions, browser, execution, hallucination detection, updater, user profile
- **MCP client** — connect to any MCP server (stdio or SSE)
- **YAML pipelines** — DAG-based workflow engine with parallel waves, dependencies, and retries
- **Multi-session management** — persistent JSONL sessions with REPL commands
- **Project map** — automatic file walker + export extraction + disk cache
- **i18n** — all user-facing strings via `t()`, English and Russian included
- **8K–120K context** — adapts to any model's context window
- **No TUI** — minimal CLI + REPL with markdown-to-ANSI formatting
- **llama.cpp / Jinja proven** — battle-tested against Jinja template edge cases (system-first, streaming fallback, explicit `stream: false`)

---

## Installation

### Prerequisites

- **Runtime:** [Bun](https://bun.sh) (recommended) or Node.js ≥ 20
- **LLM backend:** Any OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp, Together AI)

### From npm

```bash
npm install -g micro-models-agent
```

### From source

```bash
git clone https://github.com/your-org/micro-models-agent
cd micro-models-agent
bun install
bun run build
```

---

## Quick Start

### 1. Start your LLM backend

Point MMA to any OpenAI-compatible endpoint. Example with LM Studio:

```bash
# LM Studio listens on http://localhost:1234 by default
```

### 2. Run the setup wizard

```bash
bun run mma init
```

Scans local ports, finds your model, tests the connection, and writes config.

### 3. Use the agent

```bash
# One-shot mode
bun run mma "create a REST API with Express and add tests"

# Interactive REPL
bun run dev
```

---

## Usage

### CLI

```bash
bun run mma "<prompt>"

# Subcommands
bun run mma init                       # Interactive setup wizard
bun run mma config set model qwen3.5-9b
bun run mma config show
bun run mma model list                 # List available models
bun run mma model use qwen3.5-9b       # Switch model
bun run mma provider list              # List configured providers
bun run mma session list               # List sessions
bun run mma session show <id>          # Show session details
bun run mma session delete <id>        # Delete a session
```

### REPL

```bash
bun run dev
```

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | | Show help |
| `/sessions` | `/ls` | List all sessions (* = active) |
| `/new <name>` | `/create` | Create a new session |
| `/resume <id\|name>` | `/switch`, `/use` | Switch to a session |
| `/rename <name>` | | Rename current session |
| `/delete <id>` | `/rm` | Delete a session |
| `/config set <key> <value>` | | Set a config value |
| `/exit` | | Exit REPL |

### Development

```bash
bun run mma "fix the login page"       # Run agent
bun run dev                            # Watch mode (auto-restart on changes)
bun run build                          # TypeScript build
bun test                               # Run tests
tsc --noEmit                           # Type-check
```

---

## Configuration

3-layer config: `defaults.ts` → `~/.mma/config.json` (global) → `.mmrc` (project) + env vars.

Key options (see `src/config/defaults.ts` for full list):

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `qwen3.5-9b` | Model name sent to backend |
| `provider.baseUrl` | `http://localhost:1234/v1` | OpenAI-compatible API URL |
| `contextWindow` | `32768` | Model's context window in tokens |
| `autoPlan` | `true` | Auto-create plans for multi-step tasks |
| `maxToolIterations` | `25` | Max tool calls per agent run |
| `stuckThreshold` | `8` | Iterations without progress before stuck detection |
| `moe.enabled` | `false` | Enable Agent-Level MoE |
| `locale` | `en` | UI locale (`en` / `ru`) |
| `logLevel` | `info` | Log level |

### Agent-Level MoE

```json
{
  "moe": { "enabled": true },
  "orchestrator": {
    "model": "qwen3-70b-414k",
    "provider": { "baseUrl": "http://localhost:1234/v1" }
  },
  "experts": {
    "code": { "model": "qwen3.5-9b", "tool_tags": ["file", "code", "shell"], "max_attempts": 3 },
    "research": { "model": "qwen3.5-9b", "tool_tags": ["research"], "max_attempts": 3 },
    "browser": { "model": "qwen3.5-9b", "tool_tags": ["browser", "vision"], "max_attempts": 3 }
  }
}
```

---

## Architecture

```
CLI (main.ts → commands.ts / repl.ts / setup.ts)
  → Core (agent.ts state machine → prompt-builder.ts)
    → LLM Layer (provider.ts → openai-compat.ts → response.ts → token-counter.ts)
      → Tools (registry.ts → executor.ts → 20+ tools)
        → Modules (skills, plugins, mcp, pipelines, indexer, memory, context, session,
                   hallucination, execution, updater, user-profile, browser)
```

### Project Structure

```
src/
├── core/          # Agent loop, prompt builder, types
├── llm/           # Provider abstraction, OpenAI-compat, streaming, token counting
├── tools/         # 20+ tools with registry, executor, scope guards
├── modules/       # 13 modules (skills, plugins, mcp, pipelines, indexer, memory, context, session, hallucination, execution, updater, user-profile, browser)
├── cli/           # Entry point, commands, REPL, setup wizard
├── config/        # 3-layer config: defaults → global → project
├── i18n/          # en.json + ru.json + t() function
├── ui/            # Markdown→ANSI formatter
└── logger/        # Structured logger with levels + child loggers
```

---

## Tool Reference

| Tool | Description |
|------|-------------|
| `read_file` | Read file with offset/limit |
| `write_file` | Create/overwrite with directory creation |
| `edit_file` | Find-replace in existing files |
| `glob` | Glob pattern matching |
| `grep` | Regex content search via ripgrep |
| `list_dir` | List directory contents |
| `create_dir` | Create directory (recursive) |
| `delete_file` | Delete file or empty directory |
| `move_file` | Move/rename file or directory |
| `file_info` | File/directory metadata |
| `bash` | Shell command execution |
| `subagent` | Isolated sub-agent with scope |
| `web_search` | Web search |
| `web_fetch` | Web page fetch (15K chars, 15s timeout) |
| `web_browse` | Playwright browser (click, type, scroll, screenshot) |
| `plan` | Create/update/cancel plans |
| `todo` | Track todo items |
| `question` | Ask user for input |
| `approve` | Request user approval |
| `load_skill` | Load a skill at runtime |
| `pipeline_run` | Execute a YAML pipeline |
| `mcp_call` | Call an MCP server tool |
| `search_history` | Search session history |
| `project_map` | Query project index (summary, refresh, find) |

---

## Testing

```bash
bun test                    # Unit + component tests
bun test tests/agent.test.ts   # Single file
bun run test:integration    # Integration tests (requires LLM backend)
tsc --noEmit                # Type-check
```

---

## Design Principles

1. **No file >300 lines** — split when approaching limit
2. **Small files, single responsibility** — each file does one thing
3. **KISS state machine** — no god objects, no if-else nesting in agent loop
4. **Plugin error isolation** — one plugin crash never stops others
5. **Path safety** — all filesystem tools check `targetPath.startsWith(baseDir)`
6. **TDD** — write test first, then implement, then commit
7. **No hardcoded user-facing strings** — all text through `t()` i18n function
8. **No keyword matching** — LLM decides when to plan, not heuristics
9. **No TUI** — minimal CLI + REPL with markdown→ANSI

---

## License

MIT

---

## Acknowledgments

- [Qwen3.5-9B](https://qwen.readthedocs.io/) — the primary target model
- [LM Studio](https://lmstudio.ai/) — recommended local inference server
- [llama.cpp](https://github.com/ggerganov/llama.cpp) — the inference engine

---

**Made for local models. Runs everywhere.**
