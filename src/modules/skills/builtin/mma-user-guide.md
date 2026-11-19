---
name: mma-user-guide
description: Working with MMA — setup, providers, models, config, tools, sessions, skills, security, diagnostics
keywords: [mma, setup, provider, model, config, tools, sessions, skills, security, help]
mma_version: 2
---

# MMA User Guide

MMA (Micro Models Agent) is a general-purpose agent harness for small local and hosted
LLMs (32K–64K context). Surfaces: terminal REPL/TUI (`mma`), browser UI (`mma web`),
HTTP service (`mma serve`), one-shot (`mma "<prompt>"`). This guide is the authoritative
command surface — when the user asks "how do I… with MMA", answer from it.

## First-time setup

- `mma setup` (CLI) or `/wizard` in REPL (alias `/setup`) — provider wizard.
- `mma meet` or `/meet` — interactive onboarding: profile, domain, language.
- Config lives in `~/.mma/config.json` (`MMA_CONFIG_DIR` overrides the dir). Writes are
  atomic; some keys produce effects (`provider.rebuild`, `context.resize`) on save.

## Providers and models

- Built-in provider types: `openai-compat` (LM Studio/Ollama/vLLM), `lmstudio`
  (localhost:1234), `openrouter`, `openai`, `anthropic`, `opencode-zen`, `opencode-go`.
- CLI: `mma provider list | use <name> | check [--timeout ms] | add <name> [--url <url>]
  [--key <key>] [--priority <n>] [--context-window <n>] [--rpm <n>] [--parallel <n>]`
  (hosted names resolve their URL automatically; custom ones need `--url`).
- Providers are records in `provider.entries[]` with failover by `priority`; the active
  entry is resolved from `provider.active`, not legacy fields.
- REPL: `/provider` (switch/view), `/model <name>`, `/context <n>` (context window).
- CLI: `mma model list | use <name> | certify [--provider-url … --context-window …
  --tags … --reps …] | cert-status | cert-list | uncertify` — certify validates a model
  for MMA's loop before trusting it.

## Configuration

- REPL `/config` — list all keys; `/config <key>` — show; `/config <key> <value>` —
  set; `/config reset <key>`; `/config <prefix>` browses a group (e.g. `contextBudget`).
- CLI: `mma config set|show [--show-secrets]|migrate|context [--system <f>] [--reserve <f>]`.
- Web: settings panels mirror the same registry — single source of truth.
- Most-used keys: `model`, `provider.active`, `contextWindow`, `reasoning.mode`,
  `showReasoning`, `ui.verbosity`, `locale` (`ru`/`en`), `logLevel`,
  `maxToolIterations`, `stuckThreshold`, `skills.budget` (default 0.15), `critic.*`,
  `security.*`.
- Sugar commands: `/reasoning [show|level low|medium|high]`, `/verbose`, `/status`.

## Running one-shot tasks

- `mma "<prompt>"` runs a single task. Flags: `-d <dir>` (workspace),
  `-e` / `--exit-on-complete`, `-j` / `--json` (machine output),
  `--reasoning <level>`, `--verbose`, `--context-log`, `--no-agents-md`.
- Plain `mma` opens the REPL: Tab-completes commands/keys/paths, ↑/↓ history,
  `/help [command]` for details, `/exit` (aliases `/quit`, `/q`) or Ctrl+D to leave.

## Tools the agent has

- Files: `read_file`, `write_file`, `edit_file`, `append_file`, `list_dir`, `create_dir`,
  `delete_file`, `move_file`, `file_info`, `glob`, `grep`.
- Shell & processes: `bash` (foreground/background), `process_list`, `process_log`,
  `process_wait`, `process_kill`.
- Git: `git`. Web: `web_search`, `web_fetch`, `web_browse`, `download_file`,
  `browser` (needs Chromium installed).
- Agent orchestration: `subagent` (+ `subagent_list`, `subagent_stop`, parallelizable),
  `enable_tools` (on-demand tool activation — the default set is narrow by design,
  tools are unlocked per tags, never force-loaded), `pipeline_run`, `mcp_call`,
  `define_capability`, `load_skill`.
- Interaction & memory: `question` (choices/free text), `approve` (explicit Yes/No),
  `remember`, `recall`, `search_history`, `session_info`, `attach_image`,
  `chunk_query`/`scan_corpus` (indexed corpora).
- If the agent says a capability is missing, suggest `/config` and `enable_tools`
  paths before assuming a bug.

## Sessions

- Sessions are stored per-user under `~/.mma/sessions/<id>/` (`meta.json`,
  `history.jsonl`, event log `session.jsonl`; optional encryption; dirs `0700`).
- CLI: `mma session list | show | export | delete | prune`.
- REPL: `/sessions` (list), `/resume <id>` (alias `/use`), `/rename`, `/delete`,
  `/new`, `/clear`, `/export`. Web uses `/session list|use`.
- Long sessions auto-compact within `contextWindow`; the system/response budget split
  is tunable via `/config contextBudget` / `mma config context`.

## Memory, images, plugins, updates

- Memory: the agent persists durable facts via `remember`/`recall`; inspect with
  `/memory`; history of past sessions is searchable via `search_history` and `/resume`.
- Images (vision): paste into the web composer with Ctrl+V; in REPL use `/image <path>`
  (alias `/img`) or let the agent call `attach_image`.
- Plugins and MCP: `/plugins` (REPL) or `mma plugins list | show | reload | drafts`;
  MCP servers appear in the web settings panel and are callable through `mcp_call`.
  Note: disabling a plugin is not a sandbox — its code may already have loaded.
- Subagents/experts: `mma agents init` scaffolds agent definitions; the model spawns
  helpers via `subagent` (parallelizable, budgeted tokens).
- Updates: the web panel (settings → about) installs new releases; or enable
  `/config updater.autoInstall true`. `mma changelog [--from <v>]` shows what changed.

## Skills

- Skills = task-specific knowledge packs the agent loads lazily via `load_skill`
  (always available). They share a token budget: `skills.budget` × context window.
- Sources, later wins by name: builtin (shipped) → global `~/.agents/skills/` →
  project `.mma/skills/`. Recursive scan, files `*.md` / `*.skill.md`.
- Format — frontmatter fence required; `name` required:

      ---
      name: my-skill
      description: one line the model uses to decide when to load it
      keywords: [a, b]
      mma_version: 2
      ---
      body → injected into the prompt when loaded

- REPL: `/skill list|loaded|load|unload|search <query>`; `/reload` rescans sources
  without restart. Keep skill bodies small — oversize skills fail to load.
- Supply chain: a directory with `skills-manifest.json` (sha256 per file) is
  fail-closed; adding `skills-manifest.sig.json` + `.pubkey` requires a valid Ed25519
  signature or the whole dir is skipped.

## Security

- All enforcement lives in one place (the tool executor): allowlist, tags, scope and
  protected paths, SSRF, rate limits. Handlers cannot bypass it; plugin `permissions`
  are display, not enforcement.
- Protected paths are always blocked regardless of config: `.git/`, `.env*`,
  `*.key|pem|p12|crt`, `.npmrc`, `.netrc`.
- `bash` blocks dangerous commands/flags; tune via `/security` (REPL) or
  `mma security status | policies | set-policy …`.
- Data policy keys: `security.dataPolicy.pathMode`, `security.dataPolicy.minConfidence`.

## Diagnostics and help

- `/help [command]`, `/doctor` (env health), `/status`, `/sysprompt [--full]`,
  `/map` (project map), `/lsp`, `/plugins`, `/reload`, `/memory`, `/export`.
- CLI: `mma usage` (token cost per model/provider), `mma map`, `mma changelog [--from vX]`,
  `mma doctor`.
- Logs: app log under `~/.mma/logs/`; the per-session `session.jsonl` is the full
  event record — export a session (`mma session export <id>`) and attach it when
  reporting a problem.
- Web (`mma web`): chat + settings panels; REST includes `GET /api/skills`.
- Service (`mma serve`): HTTP API v1, one tenant per process — point the user to
  `docs` on service-api for details.

Answer user questions with exact commands, not paraphrases; if a command may not exist
in the user's MMA version, say so and suggest `/help` to check.
