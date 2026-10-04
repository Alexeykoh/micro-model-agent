# MMA — Micro Models Agent v2

[![npm version](https://img.shields.io/npm/v/micro-models-agent)](https://www.npmjs.com/package/micro-models-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A universal agent harness built for small local LLMs** — the kind that fit on your laptop
(9B parameters, 32K–64K context). No cloud API required. And it is *not* a coding-only agent:
dev work, web research, home automation, API glue, personal assistant — bring any task you like.

```bash
npm install -g micro-models-agent
mma "rewrite the auth module to use JWT"
mma "what's the weather in Berlin? summarize the week"
```

Built and battle-tested with [Qwen3.5-9B](https://qwen.readthedocs.io/) via LM Studio / Ollama / llama.cpp.

---

## Why MMA?

Most agents (Devin, Cursor, Copilot) are glued to cloud models or pricey APIs — and assume the job is writing code. MMA takes a different bet: a **general-purpose** harness where coding is just one use case.

- **Tuned for 9B models** — designed around Qwen3.5-9B running on ordinary hardware
- **Cloud-optional by design** — works fully offline against any OpenAI-compatible backend
- **Thrives in a tight context** — smart sliding-window compaction keeps 32K models productive
- **Catches hallucinations** — a 3-stage validation pipeline spots the lies small models love to tell
- **Agent-Level MoE** — hierarchical task decomposition lets small models ship big multi-step work

---

## Features

**The agent loop**

- **6-state agent loop** (`INIT → THINK → ACT → OBSERVE → OUTPUT → ERROR`) — clean, predictable, debuggable
- **Context budget management** — per-model budgets with sliding-window compaction that preserves facts, decisions, and errors
- **Hallucination detection** — fact checks (file paths), consistency checks (decision rollbacks), confidence checks (short or repeated answers)
- **Execution guarantees** — LLM-driven auto-planning (no keyword heuristics), stuck detection, off-track warnings, automatic plan advancement

**Orchestration & scale**

- **Agent-Level MoE** — a router plus expert subagents with tool filtering, isolated context, file scoping, topological parallel execution, a re-plan cycle, and machine-readable verification (`success_criteria`)
- **YAML pipelines** — a DAG engine with parallel waves, dependencies, and retries
- **Project map** — file walking, export extraction, and an on-disk cache validated by freshness signature

**Tools & integrations**

- **Tools** — filesystem, shell, web search/fetch, browser (Playwright), planning, memory, subagents, MCP, pipelines, LSP, processes. A core set (~26) plus modular `plan`/`todo`/`verify`/`lsp_check`/`project_map`/`set_thinking`/`scope_request`; `question`/`approve` register only in web mode
- **24 modules** — skills, plugins, MCP, pipelines, indexer, memory, context, sessions, browser, execution, hallucination detection, updater, user profile, LSP, model certification, security, artifacts, processes, pricing, onboarding, providers, reasoning, setup, webui
- **MCP client** — connect to any MCP server (stdio or SSE)
- **LSP diagnostics** — TypeScript/CSS/HTML servers: type checks after every edit and on demand

**Experience**

- **Web mode `mma web`** — a browser chat (SSE + REST) on the same core and sessions, no TTY needed; first run opens the setup wizard right in the browser
- **Onboarding** — `mma setup` (provider wizard), `mma meet` ("Let's get acquainted": an interview written to global memory), `mma agents init` (generate/improve `AGENTS.md`)
- **Unified `/config`** — a validated settings registry plus sugar commands `/model`, `/provider`, `/context`, `/reasoning`, `/verbose`
- **Prompt caching** — cache hints (llama.cpp / OpenAI / OpenRouter) with hit-rate and savings metrics (the `⟡` cache line)
- **Context log** — `--context-log` writes the full outgoing model context to a git-style diff (`context.diff`)
- **Session management** — persistent JSONL sessions, REPL commands, `mma session export`
- **i18n** — every UI string goes through `t()`, with English and Russian bundled
- **Race-free output** — single-writer `OutputChannel`: no stray `console.*`/stdout outside the CLI and machine JSON
- **Flexible context** — adapts to any model window from 8K to 120K
- **No TUI** — a minimal CLI + REPL with markdown→ANSI formatting
- **llama.cpp / Jinja proven** — tested against tricky Jinja-template edge cases (system-first, streaming fallback, explicit `stream: false`)

**Safety**

- **Security module** — on by default (balanced policy): bash validation, path/network policies (SSRF), content scanning, session encryption, audit log, plus always-on protected paths (`.git/`, `.env*`, keys)

---

## Installation

### Requirements

- **Runtime:** [Bun](https://bun.sh) (recommended) or Node.js ≥ 20
- **LLM backend:** any OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp, Together AI)

### From npm (recommended)

```bash
npm install -g micro-models-agent@latest
```

The `mma` command is then available in your terminal. If `mma` isn't found, reopen your terminal or run:

```bash
# PowerShell
npm uninstall -g micro-models-agent
npm install -g micro-models-agent@latest

# Verify
mma --version
```

### From source

```bash
git clone https://github.com/your-org/micro-models-agent
cd micro-models-agent
bun install
bun run build:prod
```

---

## Quick Start

### 1. Start an LLM backend

Point MMA at any OpenAI-compatible endpoint. With LM Studio:

```bash
# LM Studio listens on http://localhost:1234 by default
```

### 2. Run the setup wizard

```bash
bun run mma setup
```

It scans local ports, finds a model, tests the connection, and writes your config. Legacy alias: `bun run mma init`.

### 3. Use the agent

```bash
# One-shot
bun run mma "build an Express REST API and add tests"

# Interactive REPL
bun run dev
```

---

## Usage

### CLI

```bash
bun run mma "<prompt>"

# Subcommands
bun run mma setup                      # Interactive setup wizard
bun run mma init                       # Legacy alias of mma setup (provider wizard)
bun run mma meet                       # "Let's get acquainted" — interview, writes to memory
bun run mma agents init                # Generate/improve AGENTS.md for the workspace
bun run mma config set model qwen/qwen3.5-9b
bun run mma config show
bun run mma model list                 # Available models (✔ = certified)
bun run mma model use qwen3.5-9b       # Switch model
bun run mma model certify <name>       # Certify a model against the backend
bun run mma model cert-status <name>   # Certification status
bun run mma model cert-list            # All certifications
bun run mma model uncertify <name>     # Revoke a certification
bun run mma provider list              # List providers
bun run mma provider add local --url http://localhost:1234/v1  # Add a provider
bun run mma provider use opencode-zen  # Hosted provider (zen / go)
bun run mma context                    # Context tokens/budget (--system/--reserve)
bun run mma map [summary|refresh|find] # Project map
bun run mma usage                      # Provider balance (OpenRouter /key, /credits)
bun run mma security status            # Current security configuration
bun run mma security policies          # Available policies (strict/balanced/permissive)
bun run mma security set-policy strict # Apply a policy
bun run mma plugins list               # Loaded plugins (--all includes built-in)
bun run mma session list               # List sessions
bun run mma session show <id>          # Session details
bun run mma session export <id>        # Export a session (--format md|json|jsonl, --out -)
bun run mma session delete <id>        # Delete a session
bun run mma web [--port N] [--host H] [--token T] [--no-open]  # Browser chat

# One-shot flags
bun run mma "<prompt>" --json              # Machine-readable JSON result
bun run mma "<prompt>" -d <dir>            # Agent working directory
bun run mma "<prompt>" --no-agents-md      # Don't load AGENTS.md into the system prompt
bun run mma "<prompt>" --exit-on-complete  # Exit after the first final answer
bun run mma "<prompt>" --context-log       # Write context to <session>/context.diff
bun run mma "<prompt>" --verbose           # Verbose output (verbosity level)
bun run mma "<prompt>" --reasoning <auto|low|medium|high|max>
```

### REPL

```bash
bun run dev
```

| Command | Aliases | Description |
|---------|---------|-------------|
| `/help` | | Show help |
| `/sessions` | `/ls` | List sessions (* = active) |
| `/new <name>` | `/create` | Create a new session |
| `/resume <id\|name>` | `/switch`, `/use` | Switch to a session |
| `/rename <name>` | | Rename the current session |
| `/delete <id>` | `/rm` | Delete a session |
| `/model [name]` | | Show/switch model |
| `/provider [list\|use <name>\|add …]` | | Providers (list/switch/add) |
| `/status` | | Status: model, plugins, session, cost |
| `/config [<key> [<value>]]` | | Unified settings registry (`/config reset <key>`) |
| `/context` | `/ctx` | Context tokens and budget |
| `/reasoning [show\|hide\|level <...>]` | | Reasoning display / level (`auto`/`low`/…/`max`) |
| `/verbose [quiet\|normal\|verbose]` | | Output verbosity level |
| `/memory [get\|set\|unset\|find\|forget]` | | View/edit memory |
| `/meet` | `/познакомимся` | Onboarding interview (writes to global memory) |
| `/map [summary\|refresh\|find]` | | Project map |
| `/export [md\|json\|jsonl]` | | Export the current session |
| `/image <path\|url>` | | Attach an image (or Ctrl+V) |
| `/run <cmd>` | | Run a shell command without the agent |
| `/sysprompt` | | Show the system prompt |
| `/wizard` | | Setup wizard |
| `/skill <name>` | | Load a skill |
| `/plugins` | | Plugins (`--all` for all) |
| `/lsp [status\|restart\|check <path>]` | | LSP diagnostics |
| `/reload` | | Reload config and modules |
| `/clear` | | Clear the screen (session context is preserved) |
| `/exit` | | Exit the REPL |

**Hotkeys:** `Esc Esc` — interrupt the agent; `Ctrl+C` — quit; `Ctrl+V` — paste an image from the clipboard; `Shift+Enter` — newline.

### Web mode (`mma web`)

The same `bootstrap()` / `Agent` / sessions, but in the browser (SSE + REST, no TTY):

```bash
bun run mma web                                        # opens the browser
bun run mma web --port 8080 --host 127.0.0.1 --no-open
```

- **First run** with an empty config: the wizard opens right in the browser (language → provider → key → model → context → security → review). Chat stays locked until setup is complete (the server answers `409 setup_required`).
- Settings panel: models/providers, context, reasoning, memory, skills, plugins/MCP, security. Slash commands (`/help`, `/status`, `/config`, `/model`, `/provider`, `/memory`, …) work in the browser too.
- Env: `MMA_WEBUI_PORT`, `MMA_WEBUI_HOST`, `MMA_WEBUI_TOKEN`, `MMA_WEBUI_OPEN=0`, `MMA_WEBUI_MAX_CLIENTS`.

### Development

```bash
bun run mma "fix the login page"   # Run the agent
bun run dev                        # Watch mode (auto-restart on changes)
bun run build:prod                 # Publish build (clean → bundle → frontend → assets → minify)
bun test                           # Run tests
bun run typecheck                  # Backend type check (tsc --noEmit)
bun run typecheck:frontend         # Frontend type check (tsconfig.frontend.json)
bun run lint                       # Biome linter
bun run quality                    # typecheck + frontend + lint + fallow (dead-code gate)
```

> The production build (`build:prod`) cleans `dist`, externalizes dependencies
> (`--packages external`), and minifies everything via esbuild. The package is ~1.7 MB;
> nothing is downloaded at runtime — it all arrives with `npm install`.

---

## Configuration

A 3-layer config: `defaults.ts` → `~/.mma/config/*.json` (global domains; legacy `~/.mma/config.json` migrates automatically with a backup) → `.mmrc` (project) + `MMA_*` environment variables.

Key options (full list in `src/config/defaults.ts`; view/edit via `/config` in the REPL or `mma config show`):

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `qwen/qwen3.5-9b` | Model name for the backend |
| `provider.baseUrl` | `http://localhost:1234/v1` | OpenAI-compatible API URL (or `provider.entries[]` for failover) |
| `contextWindow` | `32768` | Model context window in tokens |
| `contextBudget.systemPrompt` | `0.10` | Share of the window for the system prompt |
| `contextBudget.responseReserve` | `0.15` | Reserve for the response |
| `autoPlan` | `true` | Auto-create plans for multi-step tasks |
| `reasoning.mode` | `auto` | `auto` (policy) or fixed `none`…`max` |
| `reasoning.baseline` | `low` | Starting level in auto (grows on signals) |
| `maxToolIterations` | `1000` | Max tool calls per run |
| `stuckThreshold` | `6` | Iterations without progress before stuck detection |
| `moe.enabled` | `false` | Enable Agent-Level MoE |
| `security.enabled` | `true` | Security module (balanced policy by default) |
| `ui.verbosity` | `normal` | `quiet` / `normal` / `verbose` |
| `locale` | `en` | UI language (`en` / `ru`) |
| `logLevel` | `info` | Logging level |

### Agent-Level MoE

```json
{
  "moe": { "enabled": true },
  "orchestrator": {
    "model": "qwen3-70b-414k",
    "provider": { "baseUrl": "http://localhost:1234/v1" }
  },
  "experts": {
    "code": { "model": "qwen/qwen3.5-9b", "tool_tags": ["file", "code", "shell"], "max_attempts": 3 },
    "research": { "model": "qwen/qwen3.5-9b", "tool_tags": ["research"], "max_attempts": 3 },
    "browser": { "model": "qwen/qwen3.5-9b", "tool_tags": ["browser", "vision"], "max_attempts": 3 }
  }
}
```

---

## Architecture

```
CLI (main.ts → commands.ts / repl.ts / setup.ts / web-command.ts)
  → Core (agent.ts state machine → bootstrap.ts buildSystemInfo)
    → LLM Layer (provider.ts → openai-compat.ts → cache-usage.ts → token-counter.ts)
      → Tools (registry.ts → executor.ts → core tools + module-registered)
        → Modules (skills, plugins, mcp, pipelines, indexer, memory, context, session,
                   hallucination, execution, updater, user-profile, browser, lsp,
                   security, certification, artifacts, processes, pricing,
                   onboarding, providers, reasoning, setup, webui)
  → Output (OutputBus → OutputChannel single writer; JSON/SSE sinks)
```

### Project structure

```
src/
├── core/          # Agent loop, bootstrap/system prompt, WebHost, types
├── llm/           # Provider abstraction, OpenAI compatibility, streaming, tokens, cache metrics
├── tools/         # Tool core (~26) + registry, executor, scope guards
├── modules/       # 24 modules (skills, plugins, mcp, pipelines, indexer, memory, context,
│                  #   sessions, hallucination, execution, updater, profile, browser, LSP,
│                  #   security, certification, artifacts, processes, pricing, onboarding,
│                  #   providers, reasoning, setup, webui)
├── output/        # Single-writer OutputChannel + OutputBus, JSON/SSE sinks
├── cli/           # Entry point, commands, REPL, wizards (setup), `mma web`
├── config/        # 3-layer config: defaults → domains → project
├── i18n/          # en.json + ru.json + t()
├── ui/            # Markdown→ANSI formatter, renderer, line-editor
└── logger/        # Structured logger with levels and child loggers
```

---

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with offset/limit |
| `write_file` | Create/overwrite, creating directories as needed |
| `edit_file` | Find-and-replace in existing files |
| `glob` | Search by glob patterns |
| `grep` | Search file contents via ripgrep |
| `list_dir` | List directory contents |
| `create_dir` | Create a directory (recursively) |
| `delete_file` | Delete a file or empty directory |
| `move_file` | Move/rename a file or directory |
| `file_info` | File/directory metadata |
| `bash` | Run shell commands |
| `subagent` | Isolated, scoped subagent |
| `web_search` | Web search |
| `web_fetch` | Fetch a web page → markdown (~5K chars, 15s timeout, SSRF-safe redirects) |
| `web_browse` | JS-less HTTP page fetch without an engine (up to 3K chars) |
| `browser` | Playwright browser (click, type, scroll, screenshot) |
| `plan` | Create/update/cancel plans |
| `todo` | Task tracking |
| `load_skill` | Load a skill at runtime |
| `pipeline_run` | Run a YAML pipeline |
| `mcp_call` | Call an MCP server tool |
| `search_history` | Search session history |
| `project_map` | Query the project map (summary, refresh, find) |
| `chunk_query` | Process large texts in parallel chunks |
| `download_file` | Download a binary file by URL to disk |
| `process_list` / `process_log` / `process_kill` | Manage background processes |
| `remember` / `recall` | Persistent agent memory |
| `attach_image` | Attach an image (file/URL/clipboard; added to context with a vision model) |
| `enable_tools` | Enable hidden tool groups on the fly |
| `lsp_check` | LSP diagnostics (TypeScript/CSS/HTML) |
| `verify` | Verify plan steps |
| `session_info` | Current session info (id, model, context, messages) |
| `set_thinking` | Change the reasoning level for upcoming iterations |
| `scope_request` | Request a subagent file-scope extension |
| `question` / `approve` | Interactive menus (registered only in web mode `mma web`) |

> Note: in the terminal, the interactive tools `question`/`approve` are not registered — the model asks questions as plain text. In `mma web` they work via SSE + `POST /api/answer`.

---

## Testing

```bash
bun test                              # Unit + component tests
bun test tests/agent.test.ts          # A single file
bun run test:integration              # Integration tests (need an LLM backend)
bun run typecheck                     # Type check
```

### Agent-driven testing from the console

MMA can run headless in one-shot mode without the interactive REPL — handy for checking features and regressions from a terminal or another agent:

```bash
# One-shot: no AGENTS.md, exit right after the answer, sandboxed
bun run mma "<prompt>" --no-agents-md --exit-on-complete -d <sandbox-path>
```

- **Sandbox** — always inside `_testing/` at the project root (e.g. `_testing/<case-name>/`), never at the root or in `src/`. The `_testing/` folder is in `.gitignore`.
- **`--no-agents-md`** — don't load the project's AGENTS.md into the system prompt (clean environment).
- **`--exit-on-complete`** — exit right after the first final answer; interactive tools (`question`/`approve`) don't block stdin but return an error.
- **`-d <dir>`** — the agent's working directory (where it creates files).
- Every run is saved to the session `~/.mma/sessions/<id>/` — inspect it via `bun run mma session list` / `session show <id>`.

---

## Design Principles

1. **No file over 300 lines** — split as you approach the limit
2. **Small files, one responsibility** — each file does one thing
3. **KISS state machine** — no god objects, no nested if-else inside the agent loop
4. **Plugin error isolation** — one plugin crashing doesn't stop the others
5. **Path safety** — file tools resolve `realpath` (symlink/junction protection outside `baseDir`) and block always-on protected paths (`.git/`, `.env*`, keys)
6. **Single-writer output** — everything through `OutputChannel`; direct stdout only in the CLI and machine JSON
7. **TDD** — test first, then implementation, then commit
8. **No hardcoded strings** — all text through `t()` i18n
9. **No keyword matching** — the LLM decides when to plan, not heuristics
10. **No TUI** — a minimal CLI + REPL with markdown→ANSI

---

## License

MIT

---

## Acknowledgements

- [Qwen3.5-9B](https://qwen.readthedocs.io/) — the primary target model
- [LM Studio](https://lmstudio.ai/) — the recommended local inference server
- [llama.cpp](https://github.com/ggerganov/llama.cpp) — the inference engine

---

**Built for local models. Runs anywhere.**
