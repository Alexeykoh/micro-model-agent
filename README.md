# MMA — Micro Models Agent v2

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Status: beta](https://img.shields.io/badge/status-beta-orange.svg)](#)

> ⚠️ **Beta.** MMA is in beta: releases stay in the `0.x.y` range and **`1.0.0` is not
> released while the project is in beta**. Interfaces, config and behavior may still change
> between `0.x` releases.

**A universal agent harness built for small local LLMs** — the kind that fit on your laptop
(9B parameters, 32K–64K context). No cloud API required. And it is *not* a coding-only agent:
dev work, web research, home automation, API glue, personal assistant — bring any task you like.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.sh | bash
# Windows (PowerShell)
irm https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.ps1 | iex

mma "rewrite the auth module to use JWT"
mma "what's the weather in Berlin? summarize the week"
```

Built and battle-tested with [Qwen3.5-9B](https://qwen.readthedocs.io/) via LM Studio / Ollama / llama.cpp.

---

## Why MMA?

Most agents (Devin, Cursor, Copilot) are glued to cloud models or pricey APIs — and assume the job is writing code. MMA takes a different bet: a **general-purpose** harness where coding is just one use case.

- **Tuned for 9B models** — designed around Qwen3.5-9B running on ordinary hardware
- **Cloud-optional by design** — works fully offline against any OpenAI-compatible backend
- **Thrives in a tight context** — calibrated compaction (v2 policy) keeps 32K models productive, with a tool ledger so the agent stops re-reading what it already read
- **Catches hallucinations** — a 3-stage validation pipeline spots the lies small models love to tell, plus artifact/web/file claims and an in-loop critic
- **Agent-Level MoE** — hierarchical task decomposition lets small models ship big multi-step work

---

## Features

**The agent loop**

- **6-state agent loop** (`INIT → THINK → ACT → OBSERVE → OUTPUT → ERROR`) — clean, predictable, debuggable
- **Context budget management** — per-model budgets with sliding-window compaction that preserves facts, decisions, and errors, keeps a `[Tool ledger]` of what was already read, and calibrates its token estimate against the provider's real `prompt_tokens`
- **Honest-stop guards** — failed tool batches and duplicate-tool loops stop the loop with a truthful status instead of letting a small model grind (honest stop, duplicate-tool budget, forced tool-less final answer)
- **Hallucination detection** — fact checks (file paths), consistency checks (decision rollbacks), confidence checks, plus claim verification: "created file X" / "output says Y" / "the price is Z" are checked against real tool output
- **Execution guarantees** — LLM-driven auto-planning (no keyword heuristics), stuck detection, off-track warnings, automatic plan advancement

**Orchestration & scale**

- **Agent-Level MoE** — a router plus expert subagents with tool filtering, isolated context, file scoping, topological parallel execution, a re-plan cycle, and machine-readable verification (`success_criteria`)
- **YAML pipelines** — a DAG engine with parallel waves, dependencies, and retries
- **Project map** — symbol index (definitions, outlines, signatures), PageRank-ranked map under a token budget, gitignore-aware incremental cache, LSP fallback for symbol lookup

**Tools & integrations**

- **~37 core tools** — filesystem, shell, web search/fetch/browse, browser (Playwright), planning, memory, subagents, MCP, pipelines, LSP, processes, images; plus modular `plan`/`todo`/`verify`/`lsp_check`/`project_map`/`set_thinking`/`define_capability`, and `question`/`approve` in web mode
- **26 modules** — skills, plugins, MCP, pipelines, indexer, memory, context, sessions, browser, execution, critic, hallucination detection, updater, user profile, LSP, model certification, security, artifacts, processes, pricing, onboarding, providers, reasoning, setup, webui, service
- **MCP client** — connect to any MCP server (stdio or SSE)
- **LSP diagnostics** — TypeScript/CSS/HTML servers: type checks after every edit, on demand, and `/lsp doctor` explains why a server isn't working
- **Plugin registry** — plugins can ship their own tools; the agent can draft its own capability with `define_capability` (written to a file, inert until you approve it)

**Experience**

- **Web mode `mma web`** — a browser chat (SSE + REST) on the same core and sessions, no TTY needed; first run opens the setup wizard right in the browser. Sidebar tabs: Session, Files (workspace tree + viewer), LSP, Trace (live per-session event stream), Plugins, Map. Parallel turns per session, tab persistence, activity rail, MMART the loader face
- **Service mode `mma serve`** — the same agent as a headless HTTP service with a versioned contract (Agent Service API v1): sessions, tasks, SSE, webhooks, and a live OpenAPI 3.1 spec at `/v1/openapi.json`
- **Onboarding** — `mma setup` (provider wizard), `mma meet` ("Let's get acquainted": an interview written to global memory), `mma agents init` (generate/improve `AGENTS.md`)
- **Unified `/config`** — a validated settings registry (~110 keys) plus sugar commands `/model`, `/provider`, `/context`, `/reasoning`, `/verbose`, `/security`
- **Prompt caching** — cache hints (llama.cpp / OpenAI / OpenRouter) with hit-rate and savings metrics (the `⟡` cache line)
- **Context log** — `--context-log` writes the full outgoing model context to a git-style diff (`context.diff`)
- **Session management** — persistent JSONL sessions, auto-naming, REPL commands, `mma session export`, `mma session prune`
- **i18n** — every UI string goes through `t()`, with English and Russian bundled
- **Race-free output** — single-writer `OutputChannel`: no stray `console.*`/stdout outside the CLI and machine JSON
- **Flexible context** — adapts to any model window from 8K to 1M; the window is auto-detected from the provider unless you pin it
- **No TUI** — a minimal CLI + REPL with markdown→ANSI formatting
- **llama.cpp / Jinja proven** — tested against tricky Jinja-template edge cases (system-first, streaming fallback, explicit `stream: false`)

**Safety**

- **Security module** — on by default (balanced policy): bash validation, path/network policies (SSRF), content scanning, session encryption, audit log, plus always-on protected paths (`.git/`, `.env*`, keys)

---

## Installation

### Requirements

- **Runtime:** none — the installer downloads a self-contained build (bundled Bun runtime + agent + production dependencies)
- **LLM backend:** any OpenAI-compatible server (LM Studio, Ollama, vLLM, llama.cpp, Together AI)

### One-line installer

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.ps1 | iex
```

**macOS / Linux**:

```bash
curl -fsSL https://raw.githubusercontent.com/Alexeykoh/micro-model-agent/master/scripts/install.sh | bash
```

Open a new terminal, then run `mma setup` (provider wizard) and `mma`.

The installer detects your OS/architecture, downloads the matching release into
`~/.mma`, verifies its `sha256`, and puts the `mma` launcher on `PATH`. Re-run the
same command to update. See [docs/install.md](./docs/install.md) for layout, rollback
and uninstall.

### From source

```bash
git clone https://github.com/Alexeykoh/micro-model-agent
cd micro-models-agent
bun install
bun run build:prod      # dist/main.js + dist/assets
bun run build:release   # optional: local release tarball in ./release
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
mma setup        # or: bun run mma setup (from a source checkout)
```

It scans local ports, finds a model, tests the connection, and writes your config. Legacy alias: `mma init`. Running `mma web` on an empty config gives you the same wizard in the browser.

### 3. Use the agent

Four modes over the same agent, sessions and tools — pick by who is driving:

```bash
mma "build an Express REST API and add tests"   # one-shot
mma                                           # interactive REPL
mma web                                        # browser chat
mma serve                                      # HTTP service for your own programs
```

### 4. Want the API contract?

```bash
mma serve &
curl -s localhost:7331/v1/openapi.json | head   # OpenAPI 3.1 spec
open http://localhost:7331/v1/docs             # human-readable page
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
bun run mma config show                # Secrets redacted (--show-secrets opts out)
bun run mma config migrate             # Migrate a legacy ~/.mma/config.json
bun run mma model list                 # Available models (✔ = certified)
bun run mma model use qwen3.5-9b       # Switch model
bun run mma model certify <name>       # Certify a model against the backend
bun run mma model cert-status <name>   # Certification status
bun run mma model cert-list            # All certifications
bun run mma model uncertify <name>     # Revoke a certification
bun run mma provider list              # List providers
bun run mma provider add local --url http://localhost:1234/v1  # Add a provider
bun run mma provider use opencode-zen  # Switch the active provider
bun run mma provider check             # Probe the active provider
bun run mma context                    # Context tokens/budget (--system/--reserve)
bun run mma usage                      # Provider balance (OpenRouter /key, /credits)
bun run mma map [summary|refresh|find] # Project map
bun run mma security status            # Current security configuration
bun run mma security policies          # Available policies (strict/balanced/permissive)
bun run mma security set-policy strict # Apply a policy
bun run mma security audit-stats       # Audit log counters
bun run mma plugins list               # Loaded plugins (--all includes built-in)
bun run mma plugins show <name>        # Plugin details (tools, permissions, failures)
bun run mma plugins enable|disable <name>
bun run mma plugins drafts [approve|revoke]   # Agent-written capability drafts
bun run mma plugins reload
bun run mma session list               # List sessions
bun run mma session show <id>          # Session details
bun run mma session export <id>        # Export a session (--format md|json|jsonl, --out -)
bun run mma session delete <id>        # Delete a session
bun run mma session prune              # Drop old sessions
bun run mma web [--port N] [--host H] [--token T] [--no-open]  # Browser chat
bun run mma serve [--port N] [--host H] [--token T]           # HTTP service (Agent Service API v1)

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
| `/help [<command>]` | | Show help (usage, aliases, examples per command) |
| `/sessions` | `/ls` | List sessions (* = active) |
| `/new <name>` | `/create` | Create a new session |
| `/resume <id\|name>` | `/switch` | Switch to a session |
| `/rename <name>` | | Rename the current session |
| `/delete <id>` | `/rm` | Delete a session |
| `/model [name]` | | Show/switch model |
| `/provider [list\|use <name>\|add …]` | | Providers (list/switch/add from the REPL) |
| `/status` | | Status: model, providers, plugins, session, cost |
| `/config [<key> [<value>]]` | | Unified settings registry (`/config reset <key>\|--all`) |
| `/security [status\|<key> [value]]` | | Security summary or a single key |
| `/context [N\|system 10%\|reserve 0.2]` | `/ctx` | Context window and budget |
| `/reasoning [show\|hide\|level <...>]` | | Reasoning display / level (`auto`/`low`/…/`max`) |
| `/verbose [quiet\|normal\|verbose]` | | Output verbosity level |
| `/memory [get\|set\|unset\|find\|forget]` | | View/edit global memory |
| `/meet` | `/познакомимся` | Onboarding interview (writes to global memory) |
| `/map [summary\|refresh\|find]` | | Project map (symbol/outline lookup) |
| `/export [md\|json\|jsonl]` | | Export the current session |
| `/image <path\|url>` | `/img` | Attach an image (or Ctrl+V) |
| `/run <cmd>` | | Run a shell command without the agent |
| `/sysprompt [--full]` | | Show the system prompt |
| `/wizard` | `/setup` | Setup wizard |
| `/init` | | Deprecated alias of `/wizard` |
| `/skill <name>` | | Load a skill |
| `/plugins [list\|show\|enable\|disable\|reload]` | | Plugin registry and drafts |
| `/lsp [status\|restart\|check <path>\|doctor]` | | LSP diagnostics |
| `/reload` | | Reload config and modules |
| `/clear` | | Clear the screen (session context is preserved) |
| `/exit` | `/quit`, `/q` | Exit the REPL |

**Hotkeys:** `Esc Esc` — interrupt the agent; `Ctrl+C` — quit; `Ctrl+V` — paste an image from the clipboard; `Shift+Enter` — newline.

### Web mode (`mma web`)

The same `bootstrap()` / `Agent` / sessions, but in the browser (SSE + REST, no TTY):

```bash
bun run mma web                                        # opens the browser
bun run mma web --port 8080 --host 127.0.0.1 --no-open
```

- **First run** with an empty config: the wizard opens right in the browser (language → provider → key → model → context → security → review). Chat stays locked until setup is complete (the server answers `409 setup_required`).
- **Real parallelism** — every tab is its own session with its own agent and context; turns run concurrently, and a background session streams into its own tab. Tabs survive a reload.
- **Sidebar** — Session (plan · usage · environment), Files (lazy workspace tree + read-only viewer, click a row to attach the path to your prompt), LSP, Trace (live per-session event stream with details), Plugins, Map (project index).
- Settings panel: models/providers, context (incl. `auto` from the provider), reasoning, memory, skills, plugins/MCP, security, network (incl. Agent Service API). Slash commands (`/help`, `/status`, `/config`, `/model`, `/provider`, `/memory`, …) work in the browser too, and config writes land in the open panel immediately.
- Env: `MMA_WEBUI_PORT`, `MMA_WEBUI_HOST`, `MMA_WEBUI_TOKEN`, `MMA_WEBUI_OPEN=0`, `MMA_WEBUI_MAX_CLIENTS`.

### Service mode (`mma serve`)

Run MMA as a headless HTTP service (Agent Service API v1) for external systems — bots, backends, cron. Same agent/sessions/tools as the CLI, but a stable, versioned contract (HTTP + SSE) instead of a TTY.

```bash
bun run mma serve                                  # 127.0.0.1:7331
bun run mma serve --port 8080 --host 0.0.0.0 --token "$SECRET"
```

- **Discoverable contract** — no hunting through the repo:
  - `GET /v1/openapi.json` — machine-readable **OpenAPI 3.1** spec (feed it to Swagger UI, Redoc, Postman/Insomnia, or generate a client);
  - `GET /v1/docs` — the same contract as a human-readable page (quickstart cURL, endpoint table, SSE events, error types), self-contained HTML that works offline.
  - Both are printed on startup and served without a bearer token — they describe the public API, they don't expose tenant data.
- **1 process = 1 tenant** (silo): its own `MMA_CONFIG_DIR`, workspace, memory. A control plane maps tenants to processes; the runtime does not know about neighbours.
- **Auth:** `Authorization: Bearer <token>` for the internal control-plane call (`service.token`, mandatory for non-loopback). The runtime is **not** meant to be exposed to the internet directly.
- Endpoints: `/v1/sessions` CRUD, `/v1/sessions/:id/tasks` (jobs), `/v1/tasks/:jobId` (+`/cancel`, `/answer`), `/v1/sessions/:id/events` (SSE), `/v1/health`, `/v1/ready`.
- Task = a turn over a session: `job` (autonomous, strict `toolAllowlist`) or `interactive` (questions over SSE). Pull (`GET /v1/tasks/:jobId`) is the source of truth; SSE and HMAC-signed webhooks are optimizations. Errors are RFC 9457 Problem Details with stable `type` URIs.
- Config: `service.port`, `service.host`, `service.token`, `service.resultRetentionDays`, `service.idempotencyTtlHours`, `service.syncWaitMs`, `service.maxQueueLength`, `service.callbackTimeoutMs`, `service.webhookSecret`. Env: `MMA_SERVICE_PORT`, `MMA_SERVICE_HOST`, `MMA_SERVICE_TOKEN`.
- Full reference: [docs/agents/service-api.md](./docs/agents/service-api.md) · guide: [docs/serve-mode.md](./docs/serve-mode.md) · design: [docs/specs/2026-10-08-agent-service-api-design.md](./docs/specs/2026-10-08-agent-service-api-design.md).

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
| `provider.baseUrl` | `http://localhost:1234/v1` | OpenAI-compatible API URL of the active provider |
| `provider.entries[]` | — | Named providers (multi-provider setup); `provider.active` holds the active entry's name |
| `contextWindow` | `32768` | Model context window in tokens |
| `contextAuto` | `true` | Take the window from the provider; writing a value pins it |
| `contextBudget.systemPrompt` | `0.10` | Share of the window for the system prompt |
| `contextBudget.responseReserve` | `0.15` | Reserve for the response |
| `autoPlan` | `true` | Auto-create plans for multi-step tasks |
| `reasoning.mode` | `auto` | `auto` (policy) or fixed `none`…`max` |
| `reasoning.baseline` | `low` | Starting level in auto (grows on signals) |
| `maxToolIterations` | `200` | Max tool calls per run |
| `stuckThreshold` | `6` | Iterations without progress before stuck detection |
| `moe.enabled` | `false` | Enable Agent-Level MoE (orchestrator falls back to the active model) |
| `critic.enabled` | `true` | In-loop critic: verifies the final answer before it's accepted |
| `security.enabled` | `true` | Security module (balanced policy by default) |
| `service.port` | `7331` | Port for `mma serve` |
| `ui.verbosity` | `normal` | `quiet` / `normal` / `verbose` |
| `locale` | `en` | UI language (`en` / `ru`) |
| `logLevel` | `info` | Logging level |

Everything else — ~110 keys across context budget, reasoning, MoE, critic, plugins, images, service, providers, webui — is reachable through `/config`, `mma config show` and web Settings → … (`config show` redacts secrets unless `--show-secrets`).

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
CLI (main.ts → commands.ts / repl.ts / service-command.ts / web-command.ts / setup.ts)
  → Core (agent.ts state machine → bootstrap.ts buildSystemInfo)
    → LLM Layer (provider.ts → openai-compat.ts → cache-usage.ts → token-counter.ts)
      → Tools (registry.ts → executor.ts → core tools + module-registered)
        → Modules (skills, plugins, mcp, pipelines, indexer, memory, context, session,
                   hallucination, execution, critic, updater, user-profile, browser, lsp,
                   security, certification, artifacts, processes, pricing,
                   onboarding, providers, reasoning, setup, webui, service)
  → Output (OutputBus → OutputChannel single writer; JSON/SSE sinks)
```

Three hosts over the same core: the terminal REPL (`cli/repl.ts`), the browser
(`core/web-host.ts` + `modules/webui/`), and the HTTP service
(`modules/service/`) — each with its own transport, none reimplementing the loop.

### Project structure

```
src/
├── core/          # Agent loop, bootstrap/system prompt, WebHost, types
├── llm/           # Provider abstraction, OpenAI compatibility, streaming, tokens, cache metrics
├── tools/         # Tool core (~37) + registry, executor, scope guards
├── modules/       # 26 modules (skills, plugins, mcp, pipelines, indexer, memory, context,
│                  #   sessions, hallucination, execution, critic, updater, profile, browser, LSP,
│                  #   security, certification, artifacts, processes, pricing, onboarding,
│                  #   providers, reasoning, setup, webui, service)
├── output/        # Single-writer OutputChannel + OutputBus, JSON/SSE sinks
├── cli/           # Entry point, commands, REPL, wizards (setup), `mma web`, `mma serve`
├── config/        # 3-layer config: defaults → domains → project
├── i18n/          # en.json + ru.json + t()
├── ui/            # Markdown→ANSI formatter, renderer, line-editor
└── logger/        # Structured logger with levels and child loggers

docs/
├── serve-mode.md      # Integrator guide for `mma serve`
├── design/ui/STYLE.md # Canonical chat-output style (single source of truth)
└── agents/            # Architecture, code style, tools, modules, execution, testing, service API
```

---

## Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read a file with offset/limit |
| `write_file` | Create/overwrite, creating directories as needed |
| `edit_file` | Find-and-replace in existing files |
| `glob` | Search by glob patterns |
| `grep` | Search file contents (ripgrep → grep → built-in JS fallback) |
| `list_dir` | List directory contents |
| `create_dir` | Create a directory (recursively) |
| `delete_file` | Delete a file or empty directory |
| `move_file` | Move/rename a file or directory |
| `file_info` | File/directory metadata |
| `bash` | Run shell commands (foreground → background process) |
| `subagent` | Isolated, scoped subagent (runs in parallel within one batch) |
| `web_search` | Web search |
| `web_fetch` | Fetch a web page → markdown (SSRF-safe, main-content extraction) |
| `web_browse` | JS-less HTTP page fetch without an engine |
| `browser` | Playwright browser (click, type, scroll, screenshot) |
| `plan` | Create/update/cancel plans |
| `todo` | Task tracking |
| `verify` | Verify plan steps |
| `load_skill` | Load a skill at runtime |
| `pipeline_run` | Run a YAML pipeline |
| `mcp_call` | Call an MCP server tool |
| `search_history` | Search session history |
| `project_map` | Query the project map (summary, refresh, find, symbol, outline) |
| `chunk_query` | Process large texts in parallel chunks |
| `download_file` | Download a binary file by URL to disk |
| `process_list` / `process_log` / `process_wait` / `process_kill` | Manage background processes |
| `remember` / `recall` | Persistent agent memory |
| `attach_image` | Attach an image (file/URL/clipboard; queued into the next user message) |
| `enable_tools` | Enable hidden tool groups on the fly |
| `lsp_check` | LSP diagnostics (TypeScript/CSS/HTML) |
| `session_info` | Current session info (id, model, context, messages) |
| `set_thinking` | Change the reasoning level for upcoming iterations |
| `define_capability` | Draft a new capability (plugin tool) — inert until you approve it |
| `question` / `approve` | Interactive menus (registered only in web mode `mma web`) |

> Note: in the terminal, the interactive tools `question`/`approve` are not registered — the model asks questions as plain text. In `mma web` they work via SSE + `POST /api/answer`; in `mma serve` they are available in `interactive` tasks via `POST /v1/tasks/:jobId/answer`.

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
11. **Handler maps, not if-chains** — REPL/CLI/HTTP subcommands dispatch through a `Record<string, handler>`
12. **One source of truth per contract** — HTTP routes, the OpenAPI spec and the docs page all render from the same operation table, with a guard test

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
