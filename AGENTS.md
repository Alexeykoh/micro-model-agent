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

## Тестирование агента из консоли (agent-driven)

Агент (opencode) может тестировать MMA напрямую через терминал, без интерактивного REPL:

```bash
# Одноразовый прогон: без AGENTS.md, выход сразу после ответа, песочница
bun run mma "<промпт>" --no-agents-md --exit-on-complete -d <путь-к-песочнице>
```

- **Песочница:** всегда тестируй внутри `_testing/` в корне проекта (например `_testing/<case-name>/`), никогда в корне или в `src/`. Папка `_testing/` добавлена в `.gitignore`.
- **`--no-agents-md`** — не грузить AGENTS.md в системный промпт (иначе агент получит инструкции проекта и поведёт себя иначе, чем в чистой среде).
- **`--exit-on-complete`** — завершиться сразу после первого финального ответа; интерактивные тулзы (`question`/`approve`) не блокируют stdin, а возвращают ошибку.
- **`-d <dir>`** — рабочая директория агента (туда он создаёт файлы).
- Каждый прогон создаёт сессию в `~/.mma/sessions/<id>/` (`meta.json` + `history.jsonl` + `session.jsonl`). После прогона можно смотреть:

  ```bash
  bun run mma session list
  bun run mma session show <id>
  ```

**Правила тестового прогона:**

1. Новый тест-кейс = новая подпапка `_testing/<case-name>/`.
2. Промпт формулируй конкретно: что создать, с каким содержимым, куда.
3. Оценивай результат по фактам (файлы на месте, содержимое корректно, exit code), а не по словам агента.
4. Если тестируешь фикс/фичу — сначала `bun test` + `tsc --noEmit`, потом прогон MMA.

## Architecture

6-layer state machine agent:

```
CLI (main.ts → commands.ts / repl.ts)
  → Core (agent.ts state machine: INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR)
    → LLM Layer (provider.ts → openai-compat.ts → token-counter.ts → response.ts)
    │   └── Exponential backoff retry (3 retries, 1s/2s/4s delays, 429/5xx)
    → Tools (registry.ts → executor.ts → 20+ individual tools)
    → Modules (skills, plugins, mcp, pipelines, indexer, memory, context, session, hallucination, execution, updater, user-profile, browser, security)
```

### Security Module

> **Spec:** `docs/specs/2025-07-28-mma-v2-design.md#14-security-module` — Comprehensive security system for MMA v2.
> **Status:** **Phase 1 implemented** (Bash command validation, path restrictions, network filtering, content scanning, subagent recursion control).

The security module provides multiple layers of protection:

#### Implemented Features (Phase 1)

- **Bash Command Validation** (`src/modules/security/command-validator.ts`):
  - Blacklist of dangerous commands (`rm`, `dd`, `chmod`, `wget`, `curl`, `ssh`, etc.)
  - Whitelist mode (optional, strict)
  - Blocking of dangerous flags (`--force`, `-rf`, `--no-preserve-root`)
  - Blocking of dangerous operators (`|`, `>`, `>>`, `;`, `&&` — when `blockDangerousFlags` is enabled)
  - Command logging to `~/.mma/logs/audit.jsonl`

- **Path Validation** (`src/modules/security/path-validator.ts`):
  - Global denied paths (`.git/`, `node_modules/`, `.env`, `*.key`, etc.)
  - Global allowed paths (optional whitelist mode)
  - Integration with existing `ToolScope` for subagents
  - Applied to all filesystem tools (`read_file`, `write_file`, `delete_file`, `edit_file`, `create_dir`, `move_file`, `list_dir`, `file_info`)

- **Network Validation** (`src/modules/security/network-validator.ts`):
  - Denied domains blacklist
  - Allowed domains whitelist (optional)
  - URL sanitization (removing sensitive query parameters)
  - Applied to `web_fetch`, `web_search`, `web_browse`

- **Content Scanning** (`src/modules/security/content-scanner.ts`):
  - Detection of dangerous patterns in file content (`eval(`, `child_process.exec(`, `rm -rf`, etc.)
  - Applied to `write_file` and `edit_file`

- **Subagent Recursion Control** (`src/tools/subagent.ts`):
  - Maximum recursion depth limit (default: 3)
  - Prevents infinite subagent spawning

- **Audit Logging** (`src/modules/security/audit-log.ts`):
  - Logging of all security-relevant events to `~/.mma/logs/audit.jsonl`
  - Events: tool calls, file operations, bash commands, network requests, security blocks

- **Data Sanitization** (`src/modules/security/data-sanitizer.ts`):
  - Automatic removal of sensitive data (API keys, tokens, passwords) from logs
  - Applied to all log messages and audit entries

#### Configuration

Security settings are part of `AppConfig` in `src/config/types.ts`:

```typescript
interface SecurityConfig {
  enabled: boolean;
  bash: BashSecurityConfig;
  paths: PathSecurityConfig;
  network: NetworkSecurityConfig;
  maxRecursionDepth: number;
  maxFileOperations: number;
  rateLimits: RateLimitConfig;
  contentScan: ContentScanConfig;
  sessionEncryption: SessionEncryptionConfig;
  auditNotifier: AuditNotifierConfig;
}
```

Default configuration is defined in `src/config/security.ts` and merged with user settings in `src/config/defaults.ts`.

#### Backward Compatibility

Security is **disabled by default** (`SecurityConfig.enabled: false`):

- All validators (command, path, network, content scan) return `allowed: true` when `enabled` is `false`
- The default `DEFAULT_SECURITY_CONFIG` has empty/benign defaults — blacklists exist as templates, not active rules
- To enable security: set `security.enabled: true` and configure individual modules (bash, paths, network, contentScan)
- Each sub-module also has its own `enabled` flag for granular control
- Existing code continues to work without modifications

#### Phase 4: Extended Security Features

> **Status:** Fully implemented and tested (177 tests passing)

##### Session File Encryption (`src/modules/security/session-encryption.ts`)

- Encrypts `history.jsonl` and `session.jsonl` files using AES-256-GCM
- Configurable via `security.sessionEncryption.enabled`
- Custom key path support (`security.sessionEncryption.keyPath`)
- Backward compatible: can read old unencrypted files
- Integrated with `SessionStore` for transparent encryption/decryption

##### Audit Notifications (`src/modules/security/audit-notifier.ts`)

- File-based notifications to `~/.mma/logs/audit-notifications.jsonl`
- Webhook support for real-time notifications
- Configurable severity levels (`low`, `medium`, `high`, `critical`)
- Event type filtering (`security_block`, `bash_command`, `file_operation`, `network_request`, etc.)
- Automatic retry for failed webhook deliveries
- Statistics and analytics via `getStats()`

##### Security Policies (`src/modules/security/security-policies.ts`)

- Three preset policies:
  - **Strict**: Maximum security, minimal flexibility (recommended for production)
  - **Balanced**: Good security with reasonable flexibility (default)
  - **Permissive**: Minimal security, maximum flexibility (recommended for testing)
- Easy switching via `applySecurityPolicy('strict')`
- Custom policy support with overrides
- Use case recommendations

##### CLI Security Commands

```bash
mma security status              # Show current security configuration
mma security policies           # List available security policies
mma security set-policy strict   # Apply strict security policy
mma security enable-encryption  # Enable session file encryption
mma security disable-encryption # Disable session file encryption
mma security enable-audit        # Enable audit notifications
mma security disable-audit       # Disable audit notifications
mma security audit-stats         # Show audit notification statistics
```

## Model Certification

> **Spec:** `docs/specs/2026-08-05-model-certification-design.md` — offline harness that runs test scenarios through the real agent against a (model, provider) pair.

**Status:** Implemented.

Purpose: distinguish "this model works with MMA on this backend" from "untested". A certification is **not** a general endorsement — it states that on a specific provider URL the model ran the suite and passed N/M repetitions.

- **Commands:** `mma model certify <name> [--provider-url <url>] [--tags core,security,image,network,browser] [--reps N] [--force] [--clean]`, `mma model cert-status <name>`, `mma model cert-list`, `mma model uncertify <name>`.
- **Tags:** `core` (default, no external deps), `security` (requires `security.enabled`, pre-check fails fast), `image`, `network`, `browser`.
- **Manifest:** `~/.mma/certifications.json` — entries keyed by `(model, providerUrl)`, recording `mmaVersion`, suite summary, and per-scenario results.
- **Checkmarks:** `mma model list` and REPL `/model` show `✔` (certified on this provider, MMA version matches), `○` (certified on an older MMA version — re-run `--force`), `·` (not certified).
- **Harness mechanics:** spawns `bun src/cli/main.ts` per scenario rep with `--no-agents-md --exit-on-complete -d <sandbox>`, injecting `(model, provider)` via the existing env overrides (`MMA_MODEL`, `MMA_PROVIDER_BASEURL`, `MMA_PROVIDER_APIKEY`, `MMA_CONTEXT_WINDOW`). Fact-checks: files, exit code, output substring (`outputContains` for security scenarios). M/N tally per scenario (default 2/3).
- **Source:** `src/modules/certification/` (`types`, `scenarios`, `loader`, `fact-checker`, `runner`, `manifest`, `cli`). It is an offline tool independent of the agent loop — never part of the system prompt or context.
- **Scenarios:** builtin in `scenarios.ts` (ported from `docs/testing/scenarios.md`); user-defined YAML in `~/.mma/certification/scenarios/*.yaml`. Image fixtures in `docs/testing/fixtures/`.

### Agent-Level MoE

> **Spec:** `docs/specs/2025-07-30-agent-level-moe.md` — Router + Expert-Agent + Expert-Tools, hierarchical recursive decomposition.
>
> Status: **partially implemented (MVP)**. When `moe.enabled: true` is set in config and an orchestrator model is configured, the agent uses a Router → plan → validate → execute (parallel waves) → verify/merge flow. Falls back to single-agent when MoE fails or is disabled.
>
> ### Implemented phases
>
> - **Phase 0** — Tool tags (`tags?: string[]` on `ToolDefinition`), `filterToolsByTags()`, `ToolRegistry.getByTags()`, tag-based tool filtering in LLM calls.
> - **Phase 1** — Expert registry in config (`experts: Record<string, ExpertConfig>` with `model`, `tool_tags`, `max_attempts`), `getExpertConfig()`, `validateExpertConfig()`.
> - **Phase 2** — Subagent file scope (`ToolScope` with `allowed_files` + `read_only_files`), `isPathInScope()` / `isPathWritable()` guards in all filesystem tools, scope propagation from subagent to tool context.
> - **Phase 3** — Plan validation (`plan-validator.ts`): cycle detection, write-write overlap, read-after-write dependency checks, auto-fix for missing `depends_on`.
> - **Phase 4** — Orchestrator Router modes: `plan()` generates an `MoEPlan` from user prompt, `verifyAndMerge()` evaluates results and returns final or re-plan. JSON repair via `jsonrepair`. Max 3 re-plan cycles.
> - **Phase 5** — MoE execution engine (`moe-executor.ts`): topological sort by `depends_on`, parallel wave execution, per-subtask subagent spawning with filtered tools + scope.
> - **Phase 6** — Prompt builder integration: `toolTags` in `AgentDeps` filters LLM-visible tool set, `SubtaskContext` type in core types.
> - **Phase 7** — Retry logic: transient error detection (timeout, 5xx, network), exponential backoff retry up to `max_attempts`, structural failures feed into re-plan.
> - **Phase 8** — Global verification: `StepVerifier.verifyMoEManifest()` runs file existence checks + `tsc --noEmit` + `bun test` on artifacts.
> - **Phase 9** — Main agent loop integration in `agent.ts`: decision point at start of `run()` — if `config.moe.enabled`, delegate to `runWithMoE()`, with graceful fallback to `executeSingleAgentLoop()`.
> - **Phase 10** — This AGENTS.md update.
>
> ### Known limitations (post-MVP)
>
> - Scope expansion via `scope_request` not yet implemented.
> - Per-expert quantization (depends on provider support).
> - Dynamic expert tag discovery by LLM.
> - Cost/budget tracking per subtask.
> - Subagent tool set uses tag filtering from expert config, but the orchestrator model selection is still the base model when no separate orchestrator provider is configured.

## LLM Provider Contract (llama.cpp / OpenAI-compat)

При работе с llama.cpp (и другими бэкендами, использующими Jinja-шаблоны для сообщений) необходимо соблюдать следующие правила. Их нарушение приводит к ошибке `400: Jinja Exception` и полной неработоспособности агента на multi-turn задачах.

### Правило 1: `system` сообщение — всегда и только первое

Большинство Jinja-шаблонов (llama.cpp, vLLM) требуют, чтобы `role: "system"` сообщение было **первым** в массиве `messages`. Если system-сообщение появляется после `user`, `assistant` или `tool` — API возвращает 400.

**Было (сломано):**

```typescript
contextManager.addMessage({ role: "system", content: summary });
// → system ПОСЛЕ tool/assistant → Jinja Exception
```

**Стало (работает):**

```typescript
contextManager.addMessage({ role: "user", content: `<system-summary>${summary}</system-summary>` });
// → user, не system — не нарушает Jinja
```

**Где применяется:** `src/core/agent.ts` — после каждого tool call добавляется сводка результатов. Используй `role: "user"` с обёрткой `<system-summary>`. Никогда не добавляй `role: "system"` динамически.

### Правило 2: Streaming fallback — всегда non-streaming

Некоторые модели (Qwen 3.5-9B через llama.cpp) **не стримят JSON tool_calls** через `delta.tool_calls`. Streaming возвращает только `reasoning_content`, а финальный ответ содержит tool_calls только в non-streaming режиме.

**Логика в `openai-compat.ts`:**

1. Пробуем streaming (`doStream` — SSE через `delta.*`)
2. Если streaming не вернул ни `text`, ни `tool_call` — вызываем fallback `doNonStreaming`
3. Fallback всегда отправляет `stream: false` явно

Условие для fallback: `!hasToolCall && !hasText` — без проверки на `reasoningAcc`, потому что streaming может вернуть пустой ответ (без reasoning) на второй итерации.

### Правило 3: Non-streaming + tools = явный `stream: false`

В `doNonStreaming` тело запроса должно содержать `stream: false`. Без этого поля некоторые бэкенды (llama.cpp, особенно с кастомными шаблонами) могут парсить запрос иначе и вернуть 400.

**Было (сломано):**

```typescript
const body = { model, messages, max_tokens };
```

**Стало (работает):**

```typescript
const body = { model, messages, stream: false, max_tokens };
```

### Правило 4: tool_calls в истории — корректный формат

При добавлении `assistant` сообщения с `tool_calls` в контекст, формат должен строго соответствовать OpenAI API:

```typescript
{
  role: "assistant",
  content: textContent || "",
  tool_calls: [{
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    },
  }],
}
```

Поле `type: "function"` обязательно внутри каждого tool_call. Поле `arguments` — строка JSON. Без `type` некоторые бэкенды не распознают tool_call.

### История проблемы

Агент создавал папку (первый tool_call), но на второй итерации модель возвращала пустой ответ. Агент уходил в hallucination retry и зацикливался. Диагностика:

1. `doStream` возвращал пустой стрим (ни text, ни tool_call) на второй итерации
2. Fallback `doNonStreaming` не вызывался из-за условия `&& reasoningAcc` (reasoning был пуст)
3. Даже когда fallback вызвали (после фикса условия), он падал с 400 из-за нарушения Jinja-шаблона (system не первый, отсутствует `stream: false`)
4. Non-streaming без tools работал, но с tools — падал с `400: System message must be at the beginning` или `No user query found in messages`

**Все фиксы сделаны в:** `src/core/agent.ts`, `src/llm/openai-compat.ts`, `src/modules/context/manager.ts`, `src/modules/hallucination/confidence.ts`.

---

## Key Design Rules

1. **No file >300 lines** — split when approaching limit
2. **Small files, single responsibility** — each file does one thing
3. **KISS state machine** — no god objects, no if-else nesting in agent loop
4. **Single source of truth** — `config/defaults.ts` for config, `tools/registry.ts` for tools
5. **Plugin error isolation** — one plugin crash never stops others
6. **Path safety** — all filesystem tools check `targetPath.startsWith(baseDir)`
7. **TDD** — write test first, then implement, then commit
8. **No hardcoded user-facing strings** — ALL text shown to users MUST go through `t()` from `i18n/index.ts`. Both `en.json` and `ru.json` must have matching keys. No exceptions — CLI labels, error messages, tool outputs, REPL prompts, setup wizard text, everything.
9. **No full-screen TUI** — no alternate screen buffer, no raw-mode, no full-frame redraw. Rich ANSI output is allowed: spinner (single-line `\r` overwrite on stderr), boxed tool cards, aligned tables. Auto-degrades to plain text when `!isTTY` or `CI`.
10. **No keyword matching for task classification** — determining whether a task is multi-step, needs planning, or requires specific tools via keyword/word matching is an anti-pattern. It fails for non-English languages, ambiguous inputs, and novel task patterns. Instead, use the system prompt to instruct the model to use the `plan` tool when appropriate. The model decides whether to create a plan based on task complexity, not hardcoded heuristics.
11. **Interactive tools bypass the execution timeout** — tools that block on user input (`question`, `approve`) must set `interactive: true` on their `ToolDefinition`. The executor skips the 60s timeout for them. Any new user-facing interactive tool must do the same, and must reuse `user-input.ts` instead of creating its own readline interface.
12. **No static imports for build-time values** — never use a static import to load a value that a bundler resolves at build time (package version, build metadata). Bundlers inline it with a stale value. Always read it from disk at runtime. (Concrete repo case: read `package.json` via `readFileSync` + `fileURLToPath(import.meta.url)` with path candidates for both source `src/cli/` and bundled `dist/` layouts — see `readVersion()` in `src/cli/commands.ts`.)
13. **Separate app creation from server start** — when creating a web server (Express, FastAPI, Go http, etc.), always export the app/handler object separately from the `listen()` call. This allows tests to import and test the app without binding to a port. Pattern: create app → export app → if main module, call listen().

## Project Structure

```
src/
├── core/               # Agent loop + prompt builder + types
│   ├── agent.ts        # State machine (INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR)
│   ├── prompt-builder.ts # Collect PromptBlock[], sort by priority, fit 8K budget
│   └── types.ts        # AgentState, PromptBlock, ToolCall, ToolResult, LLMResponse
├── llm/                # LLM communication layer
│   ├── provider.ts     # LLMProvider interface (chat, countTokens)
│   ├── openai-compat.ts # OpenAI-compatible REST + SSE streaming
│   ├── token-counter.ts # js-tiktoken wrapper
│   ├── response.ts     # Parse stream chunks → typed LLMResponse
│   └── orchestrator.ts # Optional orchestrator model (planning, conflict resolution)
├── tools/              # Tool system
│   ├── registry.ts     # Single source of truth for tool definitions
│   ├── executor.ts     # Dispatch pipeline: plugins → validate → handler → plugins → log
│   ├── types.ts        # ToolDefinition, ToolContext, ToolResult
│   ├── read-file.ts    # Path-safe file reading with offset/limit, chunking at 300 lines, full path in output header
│   ├── write-file.ts   # Create/overwrite with intermediate dir creation
│   ├── edit-file.ts    # Find-replace in existing files
│   ├── glob-tool.ts    # Glob pattern matching
│   ├── grep-tool.ts    # Regex content search (via ripgrep)
│   ├── bash.ts         # Shell command execution (async spawn, background mode for long-running commands)
│   ├── process-list.ts, process-log.ts, process-kill.ts  # Background process management
│   ├── subagent.ts     # Isolated sub-agent spawning
│   ├── web-search.ts, web-fetch.ts, web-browse.ts
│   ├── download-file.ts # Download a binary file (image/archive/…) from a URL to disk; metadata-only result, size cap, path+network validation
│   ├── browser.ts      # Playwright browser tool (open, click, type, scroll, screenshot)
│   ├── attach-image.ts # Attach image from file/URL/clipboard → multimodal message
│   ├── user-input.ts   # Interactive user input primitive (menu, selection parsing, askUser)
│   ├── plan.ts, todo.ts, question.ts, approve.ts
│   ├── load-skill.ts, pipeline-run.ts, mcp-call.ts, search-history.ts
│   └── ...             # list-dir, create-dir, delete-file, move-file, file-info
│                       # Module-provided: plan/todo/verify (execution), project_map (indexer), lsp_check (lsp)
├── modules/            # All modules implement AgentModule interface
│   ├── registry.ts     # ModuleRegistry: collect blocks/tools/plugins from modules
│   ├── types.ts        # AgentModule, AgentPlugin interfaces
│   ├── skills/         # Skills loader (builtin/global/project) + progressive disclosure L1/L2/L3
│   ├── plugins/        # PluginManager with lifecycle hooks + error isolation
│   ├── mcp/            # MCP client (stdio/SSE) + server registry
│   ├── pipelines/      # DAG-based workflow engine (YAML → execute)
│   ├── indexer/        # Automatic project map: file walker + export extraction + disk cache
│   │   ├── walker.ts   # Recursive walker, language detection, export extraction
│   │   ├── cache.ts    # JSON cache of index results
│   │   └── module.ts   # AgentModule — PromptBlock + project_map tool + watch plugin
│   ├── lsp/            # LSP diagnostics (typescript/css), on-demand + write/edit plugin
│   │   ├── module.ts   # AgentModule — lsp_check tool + onAfterTool plugin (per-server disable, cap 40)
│   │   ├── check-tool.ts # lsp_check helpers: collectCheckFiles (dir walk, cap 15) + formatCheckDiagnostics
│   │   ├── client.ts   # LSP over stdio (spawn, initialize, didOpen, shutdown)
│   │   ├── command.ts  # resolveSpawnCommand + buildWinCommandLine (win32 shell)
│   │   ├── config.ts   # Per-language server config (command/args/workspaceMarkers)
│   │   └── project-root.ts # findProjectRoot via workspace markers
│   ├── memory/         # Persistent markdown (conventions.md, decisions.md, errors.md)
│   ├── context/        # ContextManager (budget calc, sliding window compaction)
│   │   └── fact-extractor.ts # FactExtractor — regex fact extraction from tool messages (split from manager.ts)
│   ├── session/        # Multi-session management
│   │   ├── types.ts    # SessionMeta, SessionMessage
│   │   ├── store.ts    # JSONL persistence on disk (~/.mma/sessions/<id>/)
│   │   ├── manager.ts  # Session lifecycle (create, list, switch, delete)
│   │   └── module.ts   # AgentModule — PromptBlock + Plugin hooks
│   ├── hallucination/  # Pre-output validation pipeline
│   │   ├── factual.ts  # Cross-check paths vs known set
│   │   ├── consistency.ts # Track decisions, detect contradictions
│   │   └── confidence.ts # Short/repetitive/uncertain markers
│   ├── execution/      # Task execution guarantees
│   │   ├── planner.ts  # Plan creation utilities (no heuristics — model decides via prompt)
│   │   ├── tracker.ts  # Step status, progress display
│   │   ├── verifier.ts # File existence + syntax + test checks
│   │   ├── stuck-detector.ts # Iteration/error thresholds, off-track guard
│   │   ├── auditor.ts  # Final audit after all steps
│   │   ├── audit-runners.ts # Test/typecheck runners + parseTypecheckErrors (split from auditor.ts)
│   │   ├── plan-tool.ts  # plan/todo/verify tool definitions (createPlanToolDefinitions factory)
│   │   └── execution-plugin.ts # plugin hooks: onBeforeThink/onBeforeTool/onToolCall/onAfterTool (createExecutionPlugin factory)
│   ├── processes/      # Background & foreground process management
│   │   ├── runner.ts   # Kill-by-call-id registry (executor timeout/abort)
│   │   ├── registry.ts # Process registry: pid tracking, output buffer, waitForExit, kill/killAll/remove
│   ├── updater/        # Self-update: async npm check + auto-install
│   │   ├── checker.ts  # Updater.check() (registry fetch) + install() (npm install -g)
│   │   └── module.ts   # UpdaterModule — fire-and-forget background loop, autoInstall
│   ├── user-profile/   # OS/shell/preferences → ~500 token compressed block
│   └── browser/        # Playwright browser module (session, snapshot, actions, cookies)
│       ├── types.ts    # BrowserConfig, BrowserState, ElementEntry, ActionResult
│       ├── driver.ts   # BrowserDriver interface + PlaywrightDriver + createBrowserDriver() (direct/Bun-bridge selection)
│       ├── bridge-client.ts # BridgeDriver — RPC over stdio to node bridge-server.mjs
│       ├── bridge-server.mjs # Node-side Playwright wrapper (plain .mjs, no bundling)
│       ├── session.ts  # BrowserSession — driver lifecycle + action dispatch
│       ├── snapshot.ts # Page → numbered accessibility tree (interactive elements)
│       ├── actions.ts  # Script builders for click, type, scroll
│       ├── cookie-store.ts # Cookie/session persistence to disk
│       └── module.ts   # AgentModule — PromptBlock + Plugin hooks
├── cli/                # CLI + REPL
│   ├── main.ts         # Entry point (commander subcommands)
│   ├── commands.ts     # init, config, model, provider, session subcommands
│   ├── repl.ts         # Readline loop with slash commands
│   ├── repl-commands.ts # REPL slash command definitions (separate from loop)
│   ├── completer.ts    # Provider-based tab completion
│   └── setup.ts        # Interactive setup wizard (port scan → test)
├── config/             # 3-layer config: defaults → global → project + env
├── i18n/               # en.json + ru.json + t() function
├── ui/                 # Rendering layer
│   ├── md-formatter.ts # Markdown→ANSI (headings, tables, quotes, checkboxes, hr, inline)
│   ├── table.ts        # Aligned tables via string-width + renderTable(headers, rows)
│   ├── box.ts          # Boxes with titles, dividers, ANSI-safe text wrapping
│   ├── spinner.ts      # Zero-dep ANSI spinner (stderr, single-line overwrite)
│   ├── renderer.ts     # Rich/plain Renderer + boxed tool cards + summarizeArgs
│   ├── diff.ts         # LCS-based diffs for file edits
│   ├── line-math.ts    # Pure line-layout math (wrapLine, buildLayout, charLen, stripAnsi)
│   ├── line-editor.ts  # Custom TTY line editor (LineInput): kitty CSI u / Shift+Enter newline, Ctrl+J, bracketed paste, visual nav, history
│   └── output.ts       # writeOutput/writeError/writeSuccess/writeWarning
├── logger/             # Structured logger with levels + child loggers
└── migration/          # MMA v1→v2 detection, backup, safe startup
```

## Question Tool

> **Status: DISABLED** — interactive menus are too disruptive for small models (Qwen3.5-9B). The model should ask questions as plain text in its response instead. Source files (`question.ts`, `approve.ts`) exist but imports are commented out in `src/tools/index.ts:29-32`. Re-enable requires uncommenting imports + adding to `registerAllTools()`.

Interactive Q&A for clarifying ambiguous tasks, gathering preferences, and offering choices to the user.

### API (disabled — kept for reference)

The model sends a `question` tool call with one or more questions:

```json
{
  "questions": [
    {
      "question": "Which framework do you prefer?",
      "header": "Framework choice",
      "options": [
        { "label": "React", "description": "Library from Meta" },
        { "label": "Vue", "description": "Progressive framework" },
        { "label": "Svelte", "description": "Compile-time framework" }
      ],
      "multiple": false,
      "custom": true
    }
  ]
}
```

**Parameters:**

| Field | Required | Description |
|-------|----------|-------------|
| `question` | yes | Complete question text |
| `header` | no | Short label (max 30 chars) shown above the question |
| `options` | no | Array of `{label, description}` choices; omit for free-text |
| `multiple` | no | Allow selecting more than one option |
| `custom` | no | Allow typing a custom answer (default: true when options present) |

### UX

- **No options:** free-text input, returns the text.
- **Single selection:** numbered menu `[1] React — ...`, user enters a number.
- **Multiple selection:** comma-separated numbers `1,3`.
- **Custom entry:** automatically appended as the last option when `custom: true`.
- **Sequential questions:** shown as `Question 1/3` in the header.

### Implementation

- `src/tools/user-input.ts` — shared interactive primitive (`parseSelection`, `formatMenu`, `askChoice`, `askText`, `askUser`).
- `src/tools/question.ts` — tool definition, normalizes legacy `{question: string}` format, calls `askUser()` sequentially per question.
- `src/tools/approve.ts` — thin wrapper: two options (Yes/No), `success:false` on reject.

### Timeout Bypass

`question` and `approve` are marked `interactive: true` in `ToolDefinition`. The executor (`executor.ts`) skips the 60-second timeout for interactive tools — they block until the user answers.

### Known Limitations

- Multiple subagents in MoE parallel waves asking questions on the same stdin would conflict. Not supported.
- No REST/SSE event system (unlike opencode). Questions work only in CLI/REPL with direct stdin.

### REPL Input Locking (`withExclusiveInput`)

When a slash command needs exclusive access to stdin (e.g., interactive setup wizard, multi-step prompt), use `Repl.withExclusiveInput(fn)` to prevent the REPL's line handler from processing input during the interactive flow:

```typescript
// In any slash command action:
action: async () => {
  await repl.withExclusiveInput(async () => {
    // Interactive readline — no REPL handler interference
    const answers = await runSetup(repl.rl);
  });
}
```

**How it works:**

- `withExclusiveInput()` sets `inputLocked = true` before running the callback
- REPL line handler checks `this.agentRunning || this.inputLocked` — skips routing to agent/commands when locked
- `finally` block guarantees `inputLocked` is cleared on errors

**When to use:**

- Any REPL command that takes over stdin for a multi-step interactive flow
- Whenever a new `readline.Interface` on `process.stdin` would conflict with the REPL's own readline
- Interactive tools should accept the REPL's existing readline instead of creating their own (see `runSetup(externalRl?)`)

### REPL Command Architecture

REPL commands are defined in `src/cli/repl-commands.ts` (separate from the REPL loop in `repl.ts`). Commands receive a `ReplContext` interface that grants access to configuration, agent, session manager, skills, plugins, readline, and control methods (`registerCommand`, `withExclusiveInput`, `runAgent`, `showHelp`).

```typescript
// src/cli/repl/commands.ts
export interface ReplContext {
  readonly config: AppConfig;
  readonly agent: Agent;
  readonly rl: LineInput; // TTY → LineEditor, non-TTY → readline.createInterface
  readonly sessionManager?: SessionManager;
  readonly skillsModule?: SkillsModule;
  readonly pluginManager?: PluginManager;
  registerCommand(cmd: SlashCommand): void;
  runAgent(input: string): Promise<void>;
  withExclusiveInput(fn: () => Promise<void>): Promise<void>;
  showHelp(): void;
  setupCompleter(): void;
}
```

**To add a new slash command:** define its action in `repl-commands.ts` — no changes to `repl.ts` needed.

### REPL Line Editor

> **Status:** custom `LineEditor` restored (v0.33.0). Node's `readline` hangs under Bun on EOF and provides no wrapping/navigation, so the REPL uses a hand-rolled editor on TTY.

- `src/ui/line-editor.ts` — `LineEditor` implements `LineInput` (setPrompt/prompt/write/question/close/on) + `onKeyInput` host hook. TTY: raw mode + `emitKeypressEvents`; non-TTY: `data`-based line reading.
- `src/ui/line-math.ts` — pure layout math (wrap-by-width, `\n` hard breaks, CJK double-width, visual col↔char mapping), unit-tested separately from the editor.
- **Keys:** Enter/CR = submit; bare LF (`enter`) = insert `\n` (this is Ctrl+J); kitty `Shift+Enter` (`\x1b[13;2u`) and `Esc+Enter` also insert newline; bracketed paste (`\x1b[200~/201~`) inserts multi-line text; `Esc Esc` interrupt; up/down history; left/right/Home/End visual navigation over wrapped lines; Tab completion.
- **Rule:** after a CR submit the following LF (`enter`) from CRLF is swallowed — no double submit.
- **Why:** popular harnesses (opencode → OpenTUI + kitty keyboard protocol; Gemini CLI → ink; Claude Code/Codex/aider → custom keypress editors) never use `readline` for interactive input; full-screen TUIs stay out per rule #9.
- **Exit flow:** `Repl(…, exitOnClose: true)` (from `main.ts`) makes the close handler / stdin `end` exit the process so piped `echo "exit" | mma` terminates; tests construct `Repl` without it so `stop()` doesn't kill the runner.

## Session Management

Sessions persist conversation history to `~/.mma/sessions/<id>/` as `meta.json`, `history.jsonl`, and `session.jsonl`.

### REPL slash commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `/sessions` | `/ls` | List all sessions (* active) |
| `/new <name>` | `/create` | Create a new session |
| `/resume <id\|name>` | `/switch`, `/use` | Switch to a session |
| `/rename <name>` | | Rename current session |
| `/delete <id>` | `/rm` | Delete a session |

### REPL Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Esc` `Esc` | Agent/tool running | Interrupt current operation, return to prompt |
| `Ctrl+C` | Any | Graceful shutdown (forces exit after 2s if agent running) |
| `Ctrl+V` | Idle (in prompt) | Paste image from clipboard |

### CLI subcommands

```bash
mma session list              # List all sessions
mma session show <id>         # Show session details
mma session delete <id>       # Delete a session
```

### Data layout

```
~/.mma/sessions/
├── ses_abc123/
│   ├── meta.json        # SessionMeta (name, model, counts, timestamps)
│   ├── history.jsonl    # JSONL of SessionMessage[] (user/assistant/tool summaries)
│   └── session.jsonl    # Detailed execution log: tool calls, args, results, timing, errors
└── ses_def456/
    ├── meta.json
    ├── history.jsonl
    └── session.jsonl
```

### Config

In `config/defaults.ts` / `~/.mma/config.json`:

```json
{
  "session": {
    "autoSave": true,
    "maxSessions": 50,
    "isolateMemory": false
  }
}
```

Messages are persisted to `history.jsonl` on each iteration. `session.jsonl` records full tool call details (arguments, raw output, duration, success/failure) for debugging and post-mortem analysis. Context compaction no longer duplicates existing messages — it writes a single compacted summary to the session. The `search_history` tool searches across all `history.jsonl` files.

**Context observability events** (in `session.jsonl`, added for post-mortem context analysis):

- `context` (kind `start`, iteration 1): initial context structure — `window`, `systemBudget`/`reserveBudget`/`historyBudget`, `systemTokens`, `toolTokens`, `contextTokens`, `quality`, `messageCount`, plus `blocks[]` — per-block system-prompt breakdown (`label`, `priority`, `tokens`, `included`) and what the budget excluded.
- `context` (kind `iteration`, every iteration): live context state before the LLM call — `contextTokens`, `quality`, `messageCount`, `compactionCount`, `iterationsSinceCompaction`. Lets you reconstruct exactly when/how the context filled up.
- `compaction` (enriched): `reason` (`interval`/`quality-triggered (N% < 40%)`/`overflow (N > M)`/`after_tool`), `tokensBefore`/`tokensAfter`, `qualityBefore`/`qualityAfter`, `messagesBefore`/`messagesAfter`, `removedTurns`/`keptTurns`, and `summary` — the actual `[Compressed: …]` block (task/files/errors/tried-and-failed). Tokens before/after come from `ContextManager.compact()` (which now returns a `CompactResult | null`, null when there is nothing to compact).
- `llm_usage` (per LLM call): `promptTokens`/`completionTokens`/`totalTokens`, `source` (`api` when the backend returned `usage`, else `estimate` — llama.cpp streaming often omits `usage`, so estimates are marked explicitly), `durationMs`.

Source: `ContextManager.getSnapshot()`/`compact()` in `src/modules/context/manager.ts`, `PromptBuilder.build()` block breakdown in `src/core/prompt-builder.ts`, logging in `src/core/session-logger.ts` (`logContext`/`logLlmUsage`/`logCompaction`).

## Browser Tool

Playwright-based headless browser for web navigation, form filling, and page interaction.

### Actions

| Action | Parameters | Description |
|--------|-----------|-------------|
| `open` | `url` | Navigate to URL, returns element snapshot |
| `click` | `target` (number) | Click element by snapshot index |
| `type` | `target`, `text` | Type text into element |
| `scroll` | `direction` (up/down/top/bottom) | Scroll page |
| `back` | — | Go back in history |
| `forward` | — | Go forward in history |
| `screenshot` | — | Capture page screenshot (vision models only) |
| `snapshot` | — | Re-read current page elements |
| `wait` | `ms` | Wait for page changes |
| `close` | — | Close browser session |

### Accessibility Tree Snapshot

Instead of raw HTML, returns compact numbered element list:

```
Page: "Example Domain"
URL: https://example.com

[1] link "More information..." → http://www.iana.org/domains/example
[2] textbox "Search" 
[3] button "Submit"
```

Model interacts using element numbers (e.g., `click(target: 1)`).

### Vision Fallback

- **Vision models** (gpt-4o, claude, etc.): receive screenshot as base64 image
- **Text-only models** (qwen3.5-9b, etc.): receive text-only message + snapshot

### Stuck Detection

Tracks repeated actions (same action + same URL × 3). Warns model to try different approach.

### Cookie Persistence

Cookies saved to `.mma/browser/cookies.json` between sessions. Enables staying logged in across agent runs.

### Config

```json
{
  "browser": {
    "enabled": true,
    "headless": true,
    "maxElements": 30,
    "maxContentChars": 2500,
    "maxConsoleEntries": 40,
    "maxConsoleLineChars": 400,
    "viewportWidth": 1280,
    "viewportHeight": 720,
    "navigationTimeout": 15000
  }
}
```

### Browser Driver + Node Bridge

> **Status:** implemented (v0.32.0). `BrowserSession` talks to a `BrowserDriver` (`src/modules/browser/driver.ts`) instead of Playwright directly. There are two drivers:

- **`PlaywrightDriver`** — direct in-process Playwright (`chromium.launch()`). Used under Node.
- **`BridgeDriver`** (`bridge-client.ts` + `bridge-server.mjs`) — Playwright runs in a child `node` process; RPC is JSON-lines over stdio (`spawn('node', [bridge-server.mjs])`).

`createBrowserDriver()` picks the driver at runtime:

- **Under Bun → BridgeDriver always.** Playwright's pipe/websocket transport hangs under Bun on some platforms (launch never returns). The bridge runs under Node, where Playwright works reliably (~85ms launch).
- **Under Node → try `PlaywrightDriver` (8s direct-launch timeout), on failure dispose and fall back to `BridgeDriver`.**

Bridge protocol: commands `ping | launch | goto | evaluate | content | title | url | waitLoad | screenshot | cookies | setCookies | back | forward | close`. Responses are `{id, ok, data|error, console, network}` — each reply carries any console/network events drained since the previous command (`goto` clears the buffers before navigating). The bridge caps console at 500 entries and network at 100; long console lines are truncated to `maxConsoleLineChars` (default 400) with `…`. Event capture is identical to the direct driver: `page.on('console')`, `page.on('pageerror')` → `ConsoleEntry`, `page.on('requestfailed')` → `NetworkErrorEntry`.

**Build/deploy note:** `bridge-server.mjs` is plain JS and must be shipped next to the bundled `dist/` — `scripts/copy-assets.ts` copies `src/modules/browser/bridge-server.mjs` → `dist/modules/browser/`. `bridge-client.ts` resolves its path via `import.meta.url`, so it works in both `src/` and `dist/` layouts. `playwright` stays `external` in the bundle (loaded via `createRequire` inside the bridge).

- The snapshot includes a **Network errors** section (last 15 failed requests: `METHOD url → errorText`) and the console buffer (capped at `maxConsoleEntries`, default 40).

## Image Handling

MMA supports attaching images to the conversation via file path, URL, or clipboard.

### Image Processing Pipeline

Uses **Bun.Image** (built-in, zero dependencies) for image processing:

1. **Clipboard paste** (`Ctrl+V` or `/image clipboard`):
   - `Bun.Image.fromClipboard()` reads PNG/JPEG/WebP/GIF/BMP from system clipboard
   - Auto-resizes to 800px max width (preserving aspect ratio)
   - Converts to JPEG quality 60 (~5-15KB, ~2-4K tokens)
   - Falls back to platform-specific commands on Linux (xclip/wl-paste)

2. **File path** (`/image ./photo.png`):
   - Reads file, resizes via Bun.Image, converts to JPEG
   - Default: 800px max width, JPEG quality 60

3. **URL** (`/image https://example.com/img.png`):
   - Fetches image, resizes, converts to JPEG

### Token Budget

- **Before**: 200KB PNG → 260KB base64 → ~65K tokens (fills 32K context instantly)
- **After**: 200KB PNG → ~10KB JPEG → ~2.5K tokens (fits comfortably)

### Sources

- `src/llm/image-utils.ts` — `readClipboardImage()`, `loadFileAsDataUrl()`, `bufferToDataUrl()`
- `src/tools/attach-image.ts` — `attach_image` tool
- `src/cli/repl.ts` — `/image` command + `Ctrl+V` handler

### Config

No configuration needed — Bun.Image is built into Bun 1.3.14+.

## Project Map

MMA automatically builds and maintains a map of the current workspace.

- Triggered at agent startup; cached to `<project>/.mma/index-cache.json`.
- Re-scans on file changes via a file watcher and exposes the result as a system prompt block.
- `project_map` tool lets the model query the current map:

| Action | Parameters | Description |
|--------|-----------|-------------|
| `summary` | — | Languages, file counts, top directories, key exports |
| `refresh` | — | Force a full re-index |
| `find` | `query` | Search files by path or exported symbol name |

- Source: `src/modules/indexer/` (`walker.ts`, `cache.ts`, `module.ts`).

## UI Rendering

Agent output flows through `src/ui/renderer.ts` (`Renderer`), chosen automatically: **rich** when `process.stdout.isTTY && !process.env.CI`, otherwise **plain**. Colors come from `src/ui/colors.ts` (`createColors`), enabled only on a TTY and disabled in CI / on `NO_COLOR` (overrides picocolors' win32 default-on).

**Event flow:** `Agent.run()` takes `(onChunk, onMeta, onTool, onPhase)`. The renderer maps:

- `text` → markdown-formatted streaming (via `FormattingStream`)
- `meta` → raw status/output lines (reasoning, tool results, MoE status)
- `onTool` `start`/`end` events → inline tool headers (rich, default) or `⚙ name` prefixes (plain)
- `onPhase` `thinking`/`done` → thinking spinner (e.g. `⠋ Thinking…`) while the model loads and generates; auto-cleared on first chunk, tool card, or `done`

**Rich mode extras:**

- Spinner (`src/ui/spinner.ts`) on stderr during LLM wait and tool execution — single-line `\r` overwrite, cleared before any text write.
- **Inline tool headers** (default, opencode-style): each tool call opens with a marker line — `← Editing path` (write/edit/create/move/delete), `→ Reading path` (read/list/file_info), `✱ Searching ...` (glob/grep), `$ Running command ...` (bash), `⚙ ...` (others). Tool output streams under a 2-space gutter (no box); `toolEnd` prints `✓ Nms` + a dim `divider()` + blank line to separate tool calls.
- **Boxed tool cards** (`ui.toolStyle: "box"`): legacy `┌─ ✓ write_file ─┐` cards with args summary, wrapped body, duration.
- Model commentary accompanying a tool call is shown by default (`ui.toolComments: true`), with a sanitizer that drops raw JSON payloads (`isToolCallJson` in `src/core/agent.ts`).
- Markdown v2: aligned tables (`│` borders), blockquotes, checkboxes, hr, italic, links.
- Diffs (`src/ui/diff.ts`) render the plain content with colored `+`/`-` markers only — no background color.

**Config:** `ui.spinner`, `ui.toolStyle` (`"inline"` default, `"box"` legacy), and `ui.toolComments` in `config/defaults.ts`. Tool `friendly` labels come from i18n `tool.friendly.*`. All user-facing strings still go through `t()` (rule #8) — this includes REPL header, `/help` groups, setup wizard, and tool cards.

## Plugins

> **Guide:** [docs/plugins.md](./docs/plugins.md) — hooks, загрузка, примеры.

Плагины перехватывают события агента. Интерфейс — `AgentPlugin` (`src/modules/types.ts`), диспетчер — `src/modules/plugins/manager.ts`. Изоляция ошибок: падение плагина не останавливает агента и других плагинов.

**Загрузка:** встроенные (`src/modules/plugins/builtin/`), глобальные `~/.mma/plugins/`, проектные `<project>/.mma/plugins/` (`.ts` — только под Bun). Два варианта размещения: **отдельный файл** `*.{ts,js}` в корне каталога плагинов, либо **папка-плагин** с entry-файлом (`plugin.ts/js` → `index.ts/js`; остальные файлы папки подключаются entry-файлом через относительные импорты — см. `src/modules/plugins/loader.ts`). Экспорт `default` или `plugin`. Папки без entry пропускаются.

**Хуки:**

| Хук | Момент | Особенность |
|-----|--------|-------------|
| `onBuildPrompt` | сборка системного промпта (1 раз) | строка добавляется блоком `low`-приоритета |
| `onBeforeThink` | перед каждым LLM-вызовом | |
| `onAfterThink(ctx, response)` | после ответа LLM | `response` = `LLMResponse` или `null` |
| `onBeforeTool` | перед тулом | `false` = заблокировать (короткозамыкает) |
| `onAfterTool` | после тула | может мутировать `result.output` |
| `onToolCall` | LLM вернул тул-вызов | `ctx.toolName`, `ctx.args` |
| `onToolStart` / `onToolEnd` | тул-карточка открыта/закрыта | `onToolEnd` даёт `result` + `durationMs` |
| `onPhase` | спиннер: `thinking` / `done` | |
| `onText` / `onMeta` | чанк стриминга | вернуть строку — заменить на экране, `undefined` — пропустить |
| `onError` | ошибка LLM | |
| `onSessionStart` / `onSessionEnd` | жизненный цикл сессии | |

**UI-хуки** (`onPhase`, `onToolStart`/`onToolEnd`, `onText`/`onMeta`) дают плагинам видимость и контроль над тем, что видит пользователь: спиннер, тул-карточки, стриминг. `onText`/`onMeta` влияют только на отображение, `result.text` не меняется.

### Versioning & dedup

- `AgentPlugin` supports optional `version` (semver) and `minMmaVersion` (minimum MMA version, semver).
- **Dedup by name** in `PluginManager.register(plugin, source?)`: the higher `version` wins (unversioned = "0.0.0"); the loser is dropped and the caller is notified via the `RegisterResult` (`registered` / `skipped_older` / `duplicate`). Applies across global + project dirs.
- **Compatibility gate** in `PluginLoader`: when `minMmaVersion` > current MMA version the plugin is skipped with a `plugin.incompatible` warning (reuses the existing `plugin.skipped` machinery). Bootstrap passes `mmaVersion` (from `readMmaVersion()` in `src/core/version.ts`) and `source` (`global` / `project`).
- **Source tracking**: `PluginInfo { plugin, source }` via `PluginManager.getPluginInfos()`. `getAllPlugins()` stays backward-compatible.
- **CLI:** `mma plugins list` (external plugins only; `--all` includes builtins) and `mma plugins list --all`; REPL `/status` shows version + `[source]` per non-builtin plugin.
- `lint-on-write` and `notify` are marked `isBuiltin = true`.

### Example plugin: `trace-server` (live browser trace)

> **Source:** `examples/plugins/trace-server/` — zero-dependency example of every UI hook, split into a **folder plugin**: `plugin.ts` (entry) + `state.ts` (process-global shared state + SSE primitives) + `util.ts` (clip/scrub/summarize) + `context.ts` (snapshots + history text) + `plans.ts` (on-disk plan reading + poll) + `server.ts` (HTTP/SSE, serves the three frontend assets verbatim) + `page.html` + `styles.css` + `app.js` (frontend). All assets are read from disk at load time and served as-is — never template-processed (inlining the page into a template literal broke `'\n'` in the JS and killed the page).

Starts a local HTTP server on `onSessionStart` and streams the whole agent loop to the browser over **SSE** (`node:http`, works under Bun and the Node dist — no `Bun.serve`/WebSocket dependency): phases, LLM calls, `tool_start`/`tool_end` with **full** args and results (paired client-side by `toolCallId`), errors, streamed text/meta (coalesced server-side, 350ms debounce), and **context tracking** — a live context bar (tokens/budget, quality %, compaction count, iterations since compaction, message count) fed by `context` events, plus `compaction` events rendered as CTX log entries (tokens before/after, quality before/after), a **side panel** with the full conversation history as text (`context_text` events, throttled + deduped) and the agent's **plans** (current, all, activity feed) read from `<project>/.mma/plans/` on disk. Live only — no session files are read. The frontend is split into three self-contained files (dark terminal, per-type color filters, search, pause/clear/auto-scroll, thinking indicator, elapsed timer, auto-reconnect): `page.html` (markup), `styles.css` (theme), `app.js` (SSE + rendering) — served from `/`, `/styles.css`, `/app.js` respectively.

The context events need the `contextManager` in the plugin hook contexts — `agent.ts` passes it to `runOnPhase`, `runOnSessionStart`, `runOnBeforeThink`, `runOnAfterThink`, `runOnToolStart`, `runOnToolEnd`, `runOnError`, `runOnText`, `runOnMeta`, `runOnSessionEnd`. Dedup: both the global and project copies of the plugin load in one process, so a shared server lives on `Symbol.for("mma.trace-server")` (`globalThis`), `startServer()` dedupes concurrent starts with an in-flight promise (`state.starting`), and identical context snapshots are broadcast once.

- Install: copy the whole `trace-server` folder to `~/.mma/plugins/` or `<project>/.mma/plugins/`; the URL is printed at session start ("live trace → …") and auto-opened.
- Config via env: `MMA_TRACE_PORT` (default random), `MMA_TRACE_HOST` (default `127.0.0.1`), `MMA_TRACE_MAX_CLIENTS` (5), `MMA_TRACE_OPEN=0` (no browser auto-open).
- Security: binds localhost only; payloads pass through a light scrub that masks credential-shaped values (`sk-…`, `Bearer …`, `api_key`/`token`/`password`/`secret` fields). Local-only, no auth.
- Smoke test: `_testing/trace-server-smoke.ts`; e2e harness in `_testing/trace-live/` (real agent run with the plugin in the sandbox's `.mma/plugins/`, watcher over SSE).

## Context Budget (dynamic, from model.contextWindow)

| contextWindow | System (10%) | Reserve (15%) | History (75%) |
|---------------|-------------|---------------|---------------|
| 32K           | 3K          | 5K            | 24K           |
| 64K           | 6K          | 10K           | 48K           |
| 128K          | 13K         | 19K           | 96K           |

Compaction triggers at 75% history budget or every 15 iterations. Keeps last 6 turns full; older turns → structured summary preserving created/updated files, plan state, key decisions, and errors. The summary is saved once to the session log — no duplication of old messages. Token counting uses `js-tiktoken` via injected `TokenCounter` when available, falling back to `content.length / 2` heuristic for backwards compatibility.

## Process Management

Long-running commands (dev servers, watchers) no longer block the agent.

### Bash behavior

- The `bash` tool uses **async spawn** (non-blocking event loop); the old `execSync` blocking behavior is gone.
- Any command still running after the grace window (5s, `BASH_GRACE_MS` in `src/tools/bash.ts`) is **auto-promoted to the background** — it returns a process id and partial output instead of hanging. Detection is behavioral (process still alive), never text matching, so a command mentioning "vite"/"dev" runs normally while a genuinely long-running command is always caught.
- Force background immediately with `background: true` (short settle window to surface spawn failures), force foreground with `background: false`.
- A command that fails to spawn (bad `workdir`, missing shell) returns `[process error] ...` with `success: false` instead of a fake "Started" line.
- Foreground commands are killed on the executor timeout (60s) via kill-by-call-id (`registerKillable` in `src/modules/processes/runner.ts`).

### Management tools

| Tool | Purpose |
|------|---------|
| `process_list` | List background processes: id, PID, command, status, last output line |
| `process_log` | Show buffered output of a background process (`id`, optional `tail`) |
| `process_kill` | Kill a background process tree (`id`) — works even though `kill`/`pkill` are blocked by the bash security blacklist |

- PIDs are tracked in `src/modules/processes/registry.ts` (per-session, capped at 20 entries, 2000 log lines each). Windows output is decoded from the OEM code page (CP866) so Cyrillic is not garbled. Output buffers are capped.
- Windows: processes are killed with `taskkill /pid <pid> /T /F`; POSIX: process-group kill (`detached` spawn).
- `Agent.shutdown()` kills all remaining background processes (no orphans).

## Auto-Update

Self-update is a fire-and-forget background check — it never blocks startup.

- **Check:** `Updater.check()` fetches `https://registry.npmjs.org/micro-models-agent` (5s timeout); the current version comes from `package.json` (`readVersion()` in `main.ts`).
- **Install:** when a newer version exists and `autoInstall: true`, runs `npm install -g micro-models-agent@<latest>` in the background (`Updater.install()`, injectable runner for tests). The running process keeps working on the old version; the update applies on next launch.
- **Config** (`updater` in `~/.mma/config.json`):
  - `enabled` (default `true`) — master switch
  - `checkOnStart` (default `true`) — check at startup
  - `autoInstall` (default `true`) — auto-run `npm install -g`; `false` → only notify
  - `intervalMs` (default `0`) — `0` = single check per launch; `>0` = permanent background re-check loop
- **Source:** `src/modules/updater/` (`checker.ts`, `module.ts`). Fired from `main.ts` via `startAutoUpdate()`; all errors are swallowed (best-effort). Notifications go through i18n keys `updater.*`.

## Execution Guarantees

### Plan Enforcement

- `autoPlan: true` adds a strong system prompt directive to create a plan for any multi-step task
- The plan is always visible in the system prompt as a checklist `[x]` / `[ ]`
- The execution module warns the model when a tool call targets files outside the current step
- After `write_file` / `edit_file`, the execution module auto-advances the plan if all files mentioned in the current step exist

### Plan Management (Multi-Plan)

Plans are stored in `<project>/.mma/plans/` with automatic history management:

```
.mma/plans/
├── active.json          # current active plan
├── drafts/              # preserved incomplete plans
│   └── <plan-id>.json
└── archive/             # completed or aborted plans
    └── <plan-id>.json
```

**Source:** `src/modules/execution/plan-store.ts` (`PlanStore`)

**Plan tool actions:**

| Action | Description |
|--------|-------------|
| `create` | Start a new plan. Previous active plan is auto-preserved: incomplete → draft, complete → archive. |
| `update` | Mark step status (done/failed/skipped). |
| `show` | Print current plan checklist. |
| `abort` | Archive current plan and clear active slot. |
| `list` | Show all plans (active, drafts, archived) with progress. |
| `switch` | Make a different plan active by plan id. |
| `re-plan` | Iterative replanning: keep completed steps, replace remaining with new steps. |

**Key behaviors:**

- Creating a new plan never destroys an existing active plan — it's automatically preserved as draft or archive
- `re-plan` keeps all done/skipped steps and appends new pending steps with sequential ids
- Legacy `.mma/plan.json` is automatically migrated to `.mma/plans/active.json` on first load
- The `Plan` interface supports optional `name` field for named plans

### Stuck Detection

- `stuckThreshold` (default 8) — too many iterations on the same step injects a recovery message
- `tool repetition` — 3 identical tool calls with the same arguments inject a recovery message
- `off-track` — tool calls touching files not in the current step trigger a warning

### Auto-Verification

- Builtin `lint-on-write` plugin runs after every `write_file` / `edit_file`
- TypeScript files: per-file `tsc --noEmit --skipLibCheck` + project-wide `tsc --noEmit --skipLibCheck` when `tsconfig.json` exists (debounced at 2s)
- JavaScript files: `node --check`
- Syntax errors are appended to the tool result so the model can fix them immediately
- **Final Audit**: Before declaring task complete, the Auditor checks plan completion (all steps done, no missing files) and runs project-wide typecheck. If incomplete, a warning is injected into context and the agent continues working.

### Final Audit Gate

- Triggered when the model returns a final answer (no tool calls) and a plan is active
- Runs `Auditor.audit(plan)` which checks: file existence from step descriptions + project-wide `tsc --noEmit --skipLibCheck`
- If audit fails (`passed: false`), injects `<system-summary>` warning with pending steps and typecheck errors
- Agent continues the loop instead of breaking — bounded by `maxToolIterations`
- Session log records audit events with type `"audit"`

## Agent Loop States

```
INIT    → collect system prompt blocks → build context
THINK   → call LLM → validate response (hallucination check)
ACT     → parse tool_call → execute via ToolExecutor
OBSERVE → process results → check termination → loop or done
OUTPUT  → show text to user → wait for input
ERROR   → retry or escalate
```

## Orchestrator (optional)

If `orchestrator.model` configured: larger model handles planning, conflict resolution, audit. Worker (9B) executes steps. If not set — everything runs on one model.

## RLM-Inspired Features (pass-by-reference + chunked queries)

> **Spec:** `docs/specs/2026-08-12-rlm-inspired-design.md` — ports Recursive Language Models (arXiv:2512.24601) mechanics: sub-agent results by reference, and programmatic chunked processing of oversized inputs.

**Status:** implemented (all 9 tasks).

### Pass-by-reference sub-agent results

- `ArtifactStore` (`src/modules/artifacts/store.ts`): persists sub-agent results to `.mma/artifacts/<session>/`. `sanitizeName()` neutralizes traversal (`../../etc/passwd` → `etc_passwd`), `read()` returns `null` outside the root, `summary()` truncates with a marker.
- `subagent` tool accepts `result_mode: "file"` (+ `artifact_name`): the child's full answer is saved to an artifact and the parent receives a bounded path + summary instead of raw text — kills context-rot/transmission errors for a 9B model.
- Config: `subagent.resultMode` (`"text"` default, backward compatible), `maxSummaryChars`, `artifactsDir`, `stableSystemPrompt`, `maxParallelChunkQueries` (`src/config/types.ts` `SubagentConfig`).
- MoE executor (`moe-executor.ts`): when `resultMode: "file"`, subtask args get `result_mode`/`artifact_name = subtask.id`, and the Router's `SubtaskResult.result` carries the full artifact content (bounded summary only in the parent's context).
- Stable system prompt: `SUBAGENT_SYSTEM_PROMPT_TEMPLATE` (`src/tools/subagent.ts`) is byte-identical across calls (KV-cache friendly); variable context goes into the user message, not the system prompt. Few-shot workflow block (write large outputs to files, verify, delegate) is included.

### Chunked parallel queries (`chunk_query`)

- `runChunkQuery()` + `splitTextIntoChunks()` (`src/modules/context/chunk-query.ts`): RLM-style `llm_query` semantics — plain LLM calls (no tool loop) per newline-aware chunk with a bounded-concurrency pool and an optional synthesis pass.
- `chunk_query` tool (`src/tools/chunk-query.ts`): scope-checked `input_path` or inline `text`, params `chunk_chars`, `max_parallel`, `synthesize`, `max_chunk_tokens` (default 1024 — must fit reasoning + answer), `max_synthesis_tokens` (2048).
- `timeoutMs` on `ToolDefinition` overrides the 60s executor timeout per tool (chunk_query uses 300s — multiple LLM calls on slow providers).
- `LLMProvider.chat(messages, tools?, signal?, options?)` gained `ChatOptions.maxTokens` to cap generation per call.

## Hallucination Detection Pipeline

```
LLM response → ConfidenceCheck (short/repetitive) 
             → FactualCheck (paths vs known set) 
             → ConsistencyCheck (decision reversal)
```

Results: `pass` → show | `warn` → show with ⚠️ | `retry` → re-call LLM | `block` (3+ retries) → ask user

## Migration Safety

MMA v2 auto-detects v1 config on first load. If `~/.mma/config.json` lacks `version: "2.0.0"` or has v1-only fields (`apiBase`, `temperature`):

1. Backs up `config.json` → `config.json.bak`
2. Backs up entire `~/.mma/` → `~/.mma.bak/`
3. Starts fresh with v2 defaults
4. Old plugins/skills with incompatible format are skipped gracefully

## Versioning Rules (Semantic Versioning)

### When to bump which part

| Version Part | When to Bump | Examples |
|-------------|--------------|----------|
| **MAJOR** (X.0.0) | Breaking changes: API changes, config schema changes, removed commands/tools, architecture rewrites | v1.0.0 → v2.0.0 (MMA v1→v2 rewrite), config version field change |
| **MINOR** (0.Y.0) | New features, new commands, new tools, new modules, new REPL commands, new CLI subcommands | Add `/reload`, `mma model list`, new security policy, new skill, new plugin hook |
| **PATCH** (0.0.Z) | Bug fixes, typo fixes, i18n additions, doc updates, performance improvements, test additions, dependency updates (non-breaking) | Fix crash in `bash` tool, add ru translation, update README, fix typo in error message |

### Release Process

1. **Code changes complete** → `bun test` + `tsc --noEmit` must pass
2. **Update version** in `package.json`:

   ```bash
   # For patch
   npm version patch
   
   # For minor  
   npm version minor
   
   # For major
   npm version major
   ```

3. **Build**: `bun run build:prod`
4. **Publish**: `npm publish --access public`
5. **Git tag**: `npm version` creates tag automatically, push with `git push --follow-tags`
6. **Update CHANGELOG** (if exists) or AGENTS.md with notable changes

### Commands that require MINOR bump

- New CLI subcommand (`mma <new-cmd>`)
- New REPL slash command (`/new-cmd`)
- New tool in `tools/`
- New module in `modules/`
- New provider capability (e.g., `listModels()` in LLMProvider)
- New config option that changes behavior
- New security policy/feature

### Commands that require PATCH bump

- Bug fixes in existing commands/tools
- i18n string additions/fixes
- Documentation updates
- Test additions
- Performance optimizations
- Dependency updates (non-breaking)

### Commands that require MAJOR bump

- Removing/renaming CLI commands
- Changing config schema (breaking)
- Removing tools/modules
- Changing Agent loop state machine
- Changing LLMProvider interface (breaking)
- Architecture rewrites

### Current Version: 0.39.0

- **46** = plugin versioning + registration (user request: «может стоит обновить регистрацию плагинов и добавить версионность?»; scope = minimal + `mma plugins list` + compatibility check): (1) **`AgentPlugin` gains optional `version` (semver) and `minMmaVersion`** (`src/modules/types.ts`); (2) **dedup by name** in `PluginManager.register(plugin, source?)` (`src/modules/plugins/manager.ts`) — the higher `version` wins (unversioned = "0.0.0"), loser dropped, caller notified via `RegisterResult` (`registered` / `skipped_older` / `duplicate`); `getPluginInfos(): PluginInfo[]` (plugin + source) while `getAllPlugins()` stays backward-compatible; (3) **compatibility gate** in `PluginLoader` (`src/modules/plugins/loader.ts`) — plugin is skipped with a `plugin.incompatible` warning when `minMmaVersion` > current MMA version; bootstrap passes `mmaVersion` (new `readMmaVersion()` in `src/core/version.ts`, rule #12) + `source` (`global`/`project`) per dir; (4) **CLI `mma plugins list`** (`src/cli/plugin-commands.ts`) — external plugins only by default (matches REPL `/status`), `--all` includes builtins; REPL `/status` shows version + `[source]` per non-builtin plugin (`repl.ts`); (5) `lint-on-write` + `notify` now `isBuiltin = true` so they don't clutter the external list; (6) trace-server declares `version: "0.1.0"` + `minMmaVersion: "0.36.0"` (needs `contextManager` in hook contexts, added in 0.36.0); frontend split into `page.html` + `styles.css` + `app.js` (AGENTS.md Plugins section updated, both plugin copies re-synced). New i18n: `plugin.incompatible`, `plugin.dedup_older`, `cli.plugins.*` (en+ru). Tests: dedup-by-version / unversioned / duplicate / source / getPlugin in `plugin-manager.test.ts` + minMmaVersion skip / source passthrough / cross-dir dedup in `plugin-loader.test.ts`. Verified: `bun test` green, `tsc --noEmit` clean, `mma plugins list` shows `trace-server v0.1.0 [global]` and skips a synthetic `minMmaVersion: 99.0.0` plugin with `plugin.incompatible`. Version: **0.39.0** (MINOR — new CLI subcommand + new plugin fields + new registration behavior).

- **45** = session post-mortem fixes (from `ses_msvuao0h_tknhsx` — a "проверь проект на ошибки" task that ran NO build and NO LSP, then declared success): (1) **`lsp_check` tool** (`src/modules/lsp/module.ts` `getToolDefinitions` + `check-tool.ts`) — LSP only ran after write/edit, so a read-only "check for errors" task got ZERO compiler feedback; the new tool returns `[LSP errors]`/`[LSP warnings]` with relative paths (cap 40), single file or directory (walk depth 4, cap 15 files, skips `node_modules/.git/.mma/dist`, only files with a configured server), `boundedOutput: true` + `timeoutMs: 90000`; per-server disable after 3 failures; constructor takes an injectable `LspClient` for tests. Rule #1: module.ts split at 265 lines (helpers moved to `check-tool.ts`). (2) **`plan create` guard** (`plan-tool.ts`) — an active plan WITH progress (done/failed/skipped) now blocks creation (`plan.active_in_progress` with id/done/total/current, the model must `plan abort` first) instead of silently dumping the 1/6 plan into drafts; a fresh plan is still replaceable (`plan.existing_fresh` note) and a passed `id` is acknowledged as ignored (`plan.id_ignored`). (3) **compaction summary carries plan + read state** — `ContextManager` gains `planSummaryProvider` (wired in `bootstrap.ts` to `ExecutionModule.getPlanSummary()`, emitted as `[Plan: ...]` so post-compaction the model continues the plan instead of re-creating it) and `FactExtractor` tracks read_file headers as `[Read: ...]` (cap 12, both locales via the `── path (...` prefix) so already-inspected files survive compaction. (4) **FactExtractor never reads the system prompt** — `errors.md`'s stale historical entries ("edit_file failed 3x" from 2026-08-15) are no longer extracted as live `[Errors:]` (role-gated to tool/assistant); (5) **bridge path in bundled dist** — v0.37.0's `bridgeScriptPath()` looked for `dist/bridge-server.mjs` but `copy-assets.ts` ships `dist/modules/browser/`; new `bridge-path.ts` `pickExistingPath()` tries sibling + dist layout (verified `build:prod`). (6) **PLAN QUALITY prompt line** — verification steps for "check/fix errors" tasks must name the exact proving command (`bun run build` / `bun test` / `lsp_check`). New i18n: `plan.active_in_progress`, `plan.id_ignored`, `plan.existing_fresh`, `lsp.check_disabled`, `lsp.check_no_path`, `lsp.check_notfound`, `lsp.check_unsupported`, `lsp.check_clean`, `tool.friendly.lsp_check` (en+ru). New tests: `tests/lsp-check-tool.test.ts`, `tests/browser-bridge-path.test.ts`, + cases in `tests/execution-plan-deliverables.test.ts` (create-guard) and `tests/context-manager.test.ts` (plan/read in summary, system-prompt error gate). Verified: `bun test` green, `tsc --noEmit` clean, `build:prod` ok. Version: **0.38.0** (MINOR — new tool + new `plan create` semantics).

- **44** = folder plugins + trace-server split (user request: «почему бы не разбить плагин на папку»): (1) **`PluginLoader` supports folder plugins** (`src/modules/plugins/loader.ts`) — a subdirectory of the plugin dir is loaded as a plugin when it contains an entry file (`plugin.ts` → `plugin.js` → `index.ts` → `index.js`); the entry imports the folder's other modules via relative imports; folders without an entry are skipped. Flat `*.ts`/`*.js` files keep working. Tests: `tests/plugin-loader.test.ts` (9 cases — flat, plugin.ts/index.ts, priority over index, no-entry skip, mixed flat+folder, broken file isolation, default export). (2) **`trace-server` example split into a folder plugin** (`examples/plugins/trace-server/`): `plugin.ts` (entry) + `state.ts` (process-global shared state + SSE primitives) + `util.ts` (clip/scrub/summarize) + `context.ts` (snapshots + conversation-text) + `plans.ts` (on-disk plan reading + poll) + `server.ts` (HTTP/SSE) + `page.html` (frontend). (3) **root cause of «не конектится / ничего не показывает»** — the page was inlined in a template literal, so `\n` inside the page's JS strings (`e.text.split('\n')`) was interpreted as a real newline, breaking the string literal and killing the whole `<script>` parse (page loaded, SSE never handled, nothing rendered). The page is now read verbatim from disk and never template-processed; `page.html` resolves relative to the plugin folder via `import.meta.url`. Docs: `docs/plugins.md` folder-plugin section, `AGENTS.md` Plugins section. Smoke test `_testing/trace-server-smoke.ts` now imports `examples/plugins/trace-server/plugin`; e2e sandbox `_testing/trace-live/.mma/plugins/` installed as a folder. Verified: `bun test` green, `tsc --noEmit` clean, `build:prod` ok, browser check (Playwright under Node) shows `status: live` + no page errors + context panel renders. Version: **0.37.0** (MINOR — new loader feature + plugin restructure).

- **43** = REPL paste fix (user report: clipboard text was "typed", not pasted): the line editor handled bracketed paste per-character — Bun's readline delivers each pasted char as a separate keypress, and the old code called `insertText()` + a full `render()` per char, so a paste appeared as fast typing with flicker, and Windows CRLF clipboard text became double newlines. Now `LineEditor` (`src/ui/line-editor.ts`) accumulates paste chars in a `pasteBuffer` between `\x1b[200~`/`\x1b[201~` and inserts them as a single batch on `paste-end` (one render per paste, not per char); `\r\n` collapses to one `\n` (`pasteLastWasCR`) and a lone trailing `\r` yields a single trailing newline; new `insertPaste()` splits the batch into real buffer lines instead of embedding literal `\n` in one string. Tests: 4 new cases in `tests/ui/line-editor.test.ts` (batch single-render, CRLF collapse, trailing CR, multi-line). Version: **0.36.3** (PATCH).

- **42** = auto-update fixes (user report: «автообновление не работает»): (1) **silent updater logger** — `startAutoUpdate()` in `main.ts` created `UpdaterModule` without a logger, so the module's fallback (`info: () => {}`) swallowed ALL updater messages (`installing`/`installed`/`available`/`check_error`); it now passes a real stderr logger (`pc.dim`/`pc.yellow`/`pc.red`) so the user actually sees the check/install progress. (2) **one-shot `process.exit()` killed the background `npm install -g`** — the updater fired as fire-and-forget, but one-shot mode (`bun run mma "<prompt>"` / `--json`) called `process.exit()` right after the agent run, terminating the in-flight install mid-write (proven with a child-process test); `main.ts` now keeps the `UpdaterModule` reference and `await updater.waitForIdle()` before `process.exit()` in one-shot mode (skipped under `--exit-on-complete` so the certification/agent-test harness stays fast and network-free). New `UpdaterModule.waitForIdle(timeoutMs = 130000)` — races the current run-loop pass promise against the timeout, no-op when never started. (3) **semver-aware update check** — `check()` used string inequality (`latest !== current`), so a local version newer than npm's `latest` was offered as a *downgrade*; new `semverGt()` (numeric x.y.z, `v`-prefix and partial parts tolerated) gates `updateAvailable`. Tests: `waitForIdle` settles after single-shot check, returns immediately when not started; `semverGt` numeric/v-prefix/partial cases + no-downgrade check. Version: **0.36.2** (PATCH).

- **41** = post-mortem fixes from two bike-shop sessions (`ses_msudj2kx_ke4wml` qwen3.5-9b + `ses_msuexz1b_lffcxt` gemma-4-12b-qat, both Vite+React+TS; per `docs/superpowers/plans/2026-08-15-agent-fix-plan.md`): (1) **final audit typecheck finds nested project root** — `Auditor.audit()` only ran `tsc` when `baseDir/tsconfig.json` existed, so an agent working in a subfolder (`bicycle-shop/`) got NO typecheck and the audit passed with 38 tsc errors; new `findTypecheckRoot(baseDir, existingFiles)` (audit-runners.ts) walks baseDir + resolved step files upward to the nearest tsconfig, and the audit now passes resolved absolute paths in `existingFiles`; (2) **unrecognized non-zero test run blocks the audit** — `runTests()` returned `failed: -1` on unrecognized runner output, and `testsFailing = failed > 0` treated it as passing; now `failed: 1` and the gate keys on `!testRun.passed` (timeouts stay non-blocking); (3) **browser bridge diagnostics + one-shot restart** — `spawnBridge()` had no `proc.on("error")` (unhandled spawn failures crashed), discarded stderr, and `send()` threw "Bridge is not running" after an unexpected exit; now error/exit handlers reject pending with the spawn message + stderr tail (300 chars), a stale-child guard (`if (this.proc !== proc) return`) prevents a respawned bridge from being nulled by a dead child's delayed exit, and `send()` respawns once with a `retried` flag; (4) **LSP per-server disable + initialize retry + CSS timeout** — a CSS `LSP request timeout: initialize` (10s npx first-run) disabled LSP GLOBALLY for the session (killing TS checks too); disable is now per-server (`failuresByServer`/`disabledServers` keyed by `command:args`), `initialize` retries once on timeout with a full `shutdown()`+`startServer()` reset, `shutdown()` clears the stale parse buffer, and CSS timeout is 20s; (5) **npm exec hint** — `npm error could not determine executable to run` (bunx/npx on a no-bin package, missing `npm run` script) now gets a concrete `exec.npm_exec_hint` hint in bash output. New i18n: `exec.npm_exec_hint` (en+ru). New tests: nested-project + no-tsconfig audit cases, `failed:-1` blocking case, bridge spawn-error/exit-restart/stale-child tests (8), LSP per-server isolation + buffer reset, `npmExecHint` unit + real-npm e2e. Version: **0.36.1** (PATCH — bugfixes + i18n keys).
- **40** = trace-server example plugin context tracking + plugin-hook `contextManager` exposure (`examples/plugins/trace-server.ts`): live context bar (tokens/budget, quality %, compaction count, iterations since compaction, message count) fed by new `context` SSE events, plus `compaction` events rendered as CTX log entries (tokens before/after, quality before/after) — detected by compaction-count growth between hook calls. The plugin hook contexts in `agent.ts` now carry `contextManager` (was only in `onBeforeThink`); passed to `runOnPhase`, `runOnSessionStart`, `runOnError`, `runOnAfterThink`, `runOnToolStart`, `runOnToolEnd`, `runOnText`, `runOnMeta`, `runOnSessionEnd`. Dedup: both the global and project copies of the plugin load in one process, so the shared server lives on `Symbol.for("mma.trace-server")` (`globalThis`), `startServer()` dedupes concurrent starts with an in-flight promise (`state.starting`), and identical context snapshots are broadcast once. Smoke test `_testing/trace-server-smoke.ts` extended with context/compaction checks (mock `contextManager` with a rising compaction count). Version: **0.36.0** (MINOR — new plugin example + new hook-context field).
- **39** = control-loop fixes from the `system-summary` injection map (`docs/2026-08-15-system-summary-injection-map.md`): (1) **plan-alignment phantom paths** — `checkPlanAlignment` extracted step/call file tokens with a raw regex `\b[\w./\\-]+\.[a-z]+` that treated domains/URLs (`weather.com`) and extension-only segments (`tsx/.ts`) as step files, so a step like "fetch weather.com data" flagged ANY unrelated write as off-path and a step "keep only .tsx/.ts files" blocked legitimate edits; it now reuses the shared `extractFileLikeTokens(stripUrls(...))` (already used by `advancePlanIfStepComplete`/`missingStepDeliverables`/`stillExistingDeliverables`), so steps without real file tokens are inert and phantom warnings vanish; (2) **hint/recovery dedup in `StuckDetector`** — new private `getPrimaryReason()` is the single source of truth for recovery priority (stuck > tool-errors > consecutive > repetitive > read-only), `getRecoveryMessage()` was refactored onto it, and `getHints()` no longer repeats the state bullet the recovery message already covers (recovery+hints emit together in the plugin cooldown block), cutting one redundant `<system-summary>` per stuck iteration; step-keyword hints and the read-only bullet under a `stuck` primary are kept. New tests: `StuckDetector hint/recovery dedup (P3)` block in `tests/execution-stuck-detector.test.ts` (4) + plan-alignment domain/extension regressions in `tests/execution-scenario-tests.test.ts` (2). Behavior of the plan-alignment mechanism itself (off-path warning, block-after-3, completed-step rewrites) unchanged. Version: **0.35.5** (PATCH).
- **38.1** = complexity refactor (per docs/superpowers/plans/2026-08-15-complexity-refactor.md + CODE-REVIEW-COMPLEXITY.md): split the ExecutionModule god object (1190→437 lines) into focused factories `plan-tool.ts` (plan/todo/verify tools) and `execution-plugin.ts` (hook surface); extracted test/typecheck runners from auditor.ts into `audit-runners.ts` (349→235 lines); extracted fact extraction from ContextManager into `FactExtractor` (`context/fact-extractor.ts`, manager.ts 597→428); shared `buildRequestBody` in openai-compat (streaming/non-streaming DRY). `agent.ts executeSingleAgentLoop` (735 lines) NOT split — deferred: it has no loop-level test harness. Rule #1 exception documented: module.ts 437, plan-tool.ts 504, execution-plugin.ts 367, manager.ts 428 remain >300 as single-responsibility units (rule #2); further splitting deemed net-negative by review. No behavior change — 166 execution + 40 context + full suite green.
- **38** = agent-loop post-mortem fixes (from `ses_mstda6uo` — a "delete js duplicates" task that spiraled into a 150-message typecheck whack-a-mole): (1) plan steps gained model-declared `kind: "create"|"delete"` — the deliverable gate now inverts for delete steps (files must be GONE), and the final audit treats a done delete-step's missing files as satisfied (leftover files fail it); (2) compaction keeps a session `mission` — a pasted error/log block (`[User feedback:]`) no longer overwrites `[Task:]`; (3) deleted files leave the compaction `[Files:]` list and are reported as `[Deleted:]`; (4) plan-coverage reads the real user task, not the injected `<system-summary>`; (5) `isFilePathLike` rejects extension-only path tokens (`tsx/.ts`) so the gate can't demand "create tsx/.ts"; (6) final audit runs a real `tsc --noEmit --skipLibCheck` (tsconfig present, 90s cap, inconclusive non-blocking) and surfaces the first error via `exec.audit_fail_typecheck`; (7) repeated forbidden Windows commands (`grep/sed/ls/find/rm/...`) in bash are hard-stopped after 2 failures (`exec.forbidden_cmd`, win32-gated). New i18n: `plan.kinds_mismatch`, `plan.kinds_invalid`, `plan.deliverables_remain`, `exec.audit_leftovers`, `exec.forbidden_cmd` (en+ru). New files: `src/modules/execution/windows-commands.ts`. New tests: `windows-commands.test.ts`, `execution-forbidden-cmd.test.ts` (+ cases in `js-identifiers`, `context-manager`, `execution-plan-deliverables`, `execution-auditor`, `execution-plan-coverage`). Version: **0.36.0** (MINOR — new plan-schema field + new audit behavior).
- **37** = session control fixes (post-mortem `ses_mssx0k11`): (1) LSP workspace root resolved from the edited file's project via per-language `workspaceMarkers` in the LSP config (`findProjectRoot` in `src/modules/lsp/project-root.ts`) — nested projects got `[LSP check failed]: Could not find a valid TypeScript installation` on every write/edit; (2) the final audit requires files only from `done` steps and treats `skipped` as terminal — a skipped step's prose no longer produces a phantom "1 files missing" loop; (3) bash Windows hint/hard-block keys on the original command word (the `cat→type` translation defeated `UNIX_TO_WIN_HINTS`); (4) tools that declare `boundedOutput` on their `ToolDefinition` (`read_file`/`list_dir`/`file_info`/`process_log`) are never budget-truncated (near-full context was cutting read_file to ~2K chars, causing re-read loops). Version: 0.35.3.
- **36** = control-loop fixes from `ses_msstxxff_th8art` post-mortem: (1) **LSP `spawn EINVAL` on Windows under Node** — the v0.33.3 `resolveSpawnCommand()` fix (ENOENT → `npx.cmd`) was insufficient: Node still throws `spawn EINVAL` spawning a `.cmd` shim without a shell, so LSP was dead for the whole session (`[LSP check failed]: spawn EINVAL` on every write/edit → the model wrote broken TS blind). `client.ts` now, on win32, builds a quoted command line via `buildWinCommandLine()` (`src/modules/lsp/command.ts`) and passes `shell: true` so the server runs through `cmd.exe /d /s /c`. (2) **plan self-certification** — `plan update step=N status=done` now verifies the step's named files actually exist (`missingStepDeliverables()` via the shared `extractFileLikeTokens` + auditor's `findExistingFile` subtree resolver) and refuses `done` with `plan.deliverables_missing` when they don't. Fixes the session's `del bicycles.ts` → `plan update step=2 done` flow that let a 1/3-done task pass the final audit. (3) **auditor summary contradicted the verdict** — when files existed but steps were pending, `audit()` emitted `exec.audit_pass` ("[✓] Task complete: 1/3 steps done"), a green light the model read as "stop working"; it now emits `exec.audit_pending` unless every step is done. New i18n: `plan.deliverables_missing`, `exec.audit_pending` (en+ru). Tests: `tests/execution-plan-deliverables.test.ts` (new), `execution-auditor.test.ts` + `lsp-command.test.ts` extended (incl. a real `.cmd`-shim spawn on win32).
- **35** = `download_file` tool (`src/tools/download-file.ts`): download a binary file (image/archive/font/…) from a URL straight to disk — `web_fetch`/`web_browse` return text only, and the 9B model's curl workaround (`curl -sL … > file`) failed 6+ times on Windows with wrong relative paths (`curl: (23) client returned ERROR on write`). The tool: resolves the path via `safeResolvePath` + `isPathWritable` (baseDir containment + subagent scope), validates the URL via network-validator, enforces a 100 MB cap (`content-length` header and post-read `arrayBuffer` size), creates intermediate directories, and returns **metadata only** (url, absolute path, size, content-type) so binary bytes never hit the 32K context. Tags `["file","research"]`, i18n `tool.friendly.download_file` / `tool.downloaded` / `tool.download_too_large`. Note: Unsplash/Pexels/Pixabay pages are behind anti-bot (Anubis/Cloudflare 403) — the tool downloads bytes from reachable direct CDN URLs, it does not bypass CAPTCHAs. New tool → **MINOR bump (0.35.0)** on release.
- **34** = indexer project profile (`src/modules/indexer/project-profile.ts`): the project map now includes a one-line stack-neutral `[Stack: …]` summary read from the workspace manifest (package.json / pyproject.toml / Cargo.toml / go.mod / requirements.txt) — name, top deps, dev deps, scripts (capped 5/3/3, best-effort parsing, no per-language behavior). Fixes the 9B model guessing "Next.js" for a Vite/React shop before reading `package.json`. Also: the indexer map block is no longer frozen at bootstrap — it moved to `getDynamicPromptBlocks` (`registry.collectPromptBlocks(exclude)`, `bootstrap.ts`), so the map refreshes inside a session instead of a snapshot string from startup.
- **33.3** = session post-mortem fixes (from `ses_mssl5izw_fqu78w` — a "simple" React fix that took 20 min and failed): (1) **auditor nested-file resolution** — plan steps naming files by bare basename ("App.tsx") or partial path ("src/App.tsx") were flagged as missing when the real file lives in a subdirectory (`bicycle-shop/src/App.tsx`) → the final audit gate rejected a completed task forever ("1 files missing") and sent the model into a read/retry loop; `auditor.ts` now resolves via bounded subtree walk (basename + path-suffix match, depth 8, skips node_modules/.git/.mma/dist). (2) **`plan show` honors `id`** — was ignoring `args.id` and always printing the active plan, so the model asking for an archived plan got the wrong one three times in a row. (3) **compaction interval reset per user turn** — `iterationsSinceCompaction` leaked across user messages, forcing a compaction on iteration 8 of the next turn that deleted the freshly-sent task; new `ContextManager.resetUserTurn()` called at the top of `Agent.run()`. (4) **`extractFacts` now captures `edit_file` "Replaced in <path>"** (the most common write signal) plus Windows drive-letter paths — previously every edit_file fact was dropped at compaction, so the model re-read the same files after every compaction. (5) **stuck detector read-only loop** — a run of 10+ consecutive read-only tool calls (read_file/glob/grep/browser/plan) with no write is now flagged with a recovery hint; `resetStepProgress()` (instead of full `reset()`) keeps the tool-call history when a plan is complete, so the "plan complete + audit rejected → 50 read-only iterations" loop is finally caught. (6) **read_file default limit 15 → 300 lines** — the 15-line default forced 10-17 calls per file (96 read_file calls / 11 compactions in ~20 min in the session); 300 covers typical component files in one call. (7) **LSP `spawn` on Windows** — `spawn("npx", …)` fails with ENOENT because Windows ships `npx.cmd`; new `resolveSpawnCommand()` in `modules/lsp/command.ts` resolves the `.cmd`/`.exe` shim on PATH so LSP diagnostics actually run on win32 (they were dead for the whole session, silently killing type feedback). (8) **`todo` tool real subtask tracking** — `todo add` now appends to a structured `step.subtasks[]` (rendered as checkboxes in the plan prompt block) instead of a `note` string, and `todo done` marks the *individual sub-task* done rather than auto-completing the whole plan step (observed: 3 × "todo done" returned "Step 3: done" and finished the plan early); new i18n `todo.no_items` / `todo.subtask_not_found`. (9) **memory learns repeated per-tool failures** — a memory rule is now written when a *single tool* fails ≥3× (per-tool counter), not only when 5 *consecutive* failures occur — so a systemic failure like LSP `spawn npx ENOENT` (8× in one session, never consecutively) finally reaches `errors.md`. (10) **compaction preserves the user's task** — `ContextManager` now tracks the turn's first real user instruction (skipping `<system-summary>`/retry envelopes) and emits it as `[Task: …]` in the compacted summary, so after compaction the model no longer forgets what it was asked to do (observed: post-compaction the model re-read files for 40+ iterations because the task "удали /bicycles, почини стили" was compacted away); `resetUserTurn()` clears the stored task so each new user message becomes the preserved one.
- **33.2** = REPL conversation layout: user/agent messages separated by divider lines (`divider()`), user prompt labeled `You:`/`Вы:` via i18n `repl.you` (agent replies already had `Agent:`). File-token heuristic inverted: `js-identifiers.ts` `isFilePathLike()` now gates bare `word.ext` tokens on an **allow-list of real file extensions** (`FILE_EXTENSIONS`) instead of a TLD deny-list — any domain (`Gismeteo.by`, `weather.com`, future TLDs) is never a file without maintaining a list; paths with a separator still accepted. Tool guidance: `browser` must not open search engines (blocked with CAPTCHA/429) — use `web_search`; `web_search` description points that out.
- **33.1** = REPL line editor redraw fix (no more duplicated multi-line input — `render()` moves back to the frame's first row via `prevCursorRow` before redrawing; `submit()`/`reset()`/`question()` commit the frame instead of erasing it); tool descriptions clarify `web_fetch`/`web_browse` are plain JS-less HTTP fetch (JS-rendered SPAs return empty content — use the `browser` tool).

- **0** = pre-1.0 (initial development)
- **22** = security `enabled` flag, security disabled by default, init/first-run apply wizard security answers, system prompt & recovery messages cleanup
- **23** = model certification module (`mma model certify`), cert checkmarks in model lists, `--model/--provider-url` env-var overrides used by the harness
- **24** = context quality formula upgrade (token load + compaction loss + error density + freshness), quality tests
- **24** = read_file display mode (show only header in REPL, full content to LLM)
- **25** = LSP module, audit gate language-agnostic, Windows command hints
- **25** = behavior-based background detection for `bash` (grace window instead of command-text heuristic), spawn error surfacing, CP866 process output decoding
- **26** = opencode-style inline tool headers (`ui.toolStyle`, default "inline"), model commentary next to tool calls (`ui.toolComments`), diffs without background color
- **27** = Windows hardening, hallucination fixes
- **28** = double-Esc interrupt fix (Bun readline collapses fast Esc Esc into one keypress — ESC bytes counted instead of events), abortable in-flight LLM requests on interrupt (`LLMProvider.chat` accepts an `AbortSignal`), clipboard paste hint when the buffer has no image
- **29** = R1–R3: smart UTF-8/OEM line decoding for process output (fixes Cyrillic mojibake on Windows), auto-detection of test-runner results (`detectTestResults`) with `[test-runner]` injections (fail → “do NOT mark done”, pass → “may mark done”), tail output (up to 400 lines) instead of head preview when tests fail, concrete stuck hints (empty CLI output → missing entry point, PowerShell cmdlets in cmd.exe, invented Bun APIs, heredoc in cmd), behavior-based background detection hardening, Windows command hints
- **30** = R4: final audit gate runs real `bun test` (90s timeout, non-blocking on timeout/unrecognized run) via process registry, `extractFailingNames()` in summary, `findTestFile()` (depth 5, skips node_modules/.git/.mma/dist), audit failure injects `<system-summary>` warning and the agent keeps working; i18n key `exec.audit_fail_tests`
- **31** = R5/R6: empty-CLI entry-point hint (`emptyCliRunHint` — file run exits 0 with no output → tell the model to check main(process.argv)/console.log; guards: test runners, redirects, non-file commands), bash tool description lists Windows anti-patterns (Write-Host, Get-Content, Select-String, Out-File, heredoc `<<`), typecheck/syntax errors in a *successful* write/edit output now feed the stuck detector (rewrite-loop hint fires on blind rewrites instead of 20+ silent iterations)
- **29** = R1–R3 regression fixes from the CSV/CLI test runs: smart output decoding on Windows (per-line UTF-8 detection with OEM/ibm866 fallback in `registry.ts` — bun/node children write UTF-8, cmd.exe writes OEM), `detectTestResults()` auto-verification in `bash` (bun test/vitest/jest/mocha/pytest markers, `[test-runner]` warning blocks marking verification steps done on failing runs, failing runs keep the output tail instead of a 15-line head preview), stuck-detector bash awareness (`recordBashOutput`: empty-output → check entry point, PowerShell cmdlets in cmd.exe, invented Bun APIs, bash heredoc hints)
- **30** = R4: Final Audit Gate actually runs `bun test` when the plan contains a verification step and test files exist (`auditor.ts` `runTests` via processRegistry, 90s cap; inconclusive runs don't block; failing test names land in the injected warning via `exec.audit_fail_tests`). Catches final answers claiming "all tests pass" while the suite fails (task-12 regression: 8/3 → 7/3 → 14/0)
- **29.0.0** = RLM-inspired features (spec `docs/specs/2026-08-12-rlm-inspired-design.md`): `ArtifactStore` (`src/modules/artifacts/store.ts`), subagent `result_mode: "file"` pass-by-reference results, `chunk_query` tool + `runChunkQuery()` chunked parallel queries, `SubagentConfig` (resultMode/maxSummaryChars/artifactsDir/stableSystemPrompt/maxParallelChunkQueries), `ChatOptions.maxTokens` + `ChatOptions.reasoningEffort` (`reasoning_effort` in OpenAI-compat body), per-tool `timeoutMs` override, stable subagent system prompt. Fix: bun test hang from leaked `mma-idle-*.js` processes — double `taskkill /T` with 150ms settle gap in `killTree` (wmic/PowerShell process enumeration was too slow under parallel load)
- **31** = session reliability fixes (from `ses_msrv83di_0hx6id` post-mortem): (1) context quality — compaction penalty capped at 0.5 floor so cumulative compactions can never pin quality below the 40% trigger (was: 56 forced compactions in 28 min); (2) forced-compaction cooldown `FORCED_COMPACTION_COOLDOWN=3` in the agent loop; (3) `extractFacts` skips `<system-summary>` messages so summaries can't nest inside themselves; (4) final audit gate returns `success:false` + `error.audit_failed` instead of "finishing anyway"; (5) LSP failures surfaced via `[LSP check failed]` + logger instead of silent `catch {}`/`return []`; (6) `plan update` refuses out-of-order `done` (`plan.order_blocked`) and re-marking a done step (`plan.step_already_done`); (7) bash hard-stops a forbidden Windows command after 3 consecutive failures (`resetBashFailureTracking` test hook)
- **32** = auto-update (`updater` module): async non-blocking npm version check on startup (`Updater.check()`, 5s timeout, registry fetch), auto-install `npm install -g micro-models-agent` when newer (`Updater.install()`), config `updater.{enabled,checkOnStart,autoInstall,intervalMs}` (defaults: enabled, autoInstall). Fired from `main.ts` via `startAutoUpdate()` (fire-and-forget, never blocks startup; best-effort, errors swallowed). i18n keys `updater.*`. Default `intervalMs: 0` = single check per launch; set >0 for a permanent background re-check loop.
- **32** = browser driver abstraction (`src/modules/browser/driver.ts`): `BrowserDriver` interface + `PlaywrightDriver` (direct, Node) + `BridgeDriver` (`bridge-client.ts` spawns `node bridge-server.mjs`, JSON-lines RPC over stdio). `createBrowserDriver()` → bridge **always under Bun** (Playwright pipe/ws transport hangs — `chromium.launch()` never returns; fixed by running Playwright in a child Node process, ~85ms launch), direct-with-8s-timeout→bridge-fallback under Node. New config `browser.maxConsoleLineChars` (default 400), `maxConsoleEntries` default 20→40; snapshot network errors now last 15 (was 5). `scripts/copy-assets.ts` ships `bridge-server.mjs` → `dist/modules/browser/`.
- **33** = REPL line editor restored (custom `LineEditor` — see REPL Line Editor section; `line-math.ts` + `line-editor.ts`, kitty CSI u / Shift+Enter / Ctrl+J / bracketed paste / visual navigation / history; non-TTY falls back to `readline.createInterface`; `Repl` `exitOnClose` flag so piped `echo "exit" | mma` terminates, while tests construct `Repl` without it). Session post-mortem fixes (from `ses_mssi3x5f`): auditor URL false-positive — plan steps containing `https://host/repo.git` were flagged as missing files (observed `whom-pointing-jewel-maine.trycloudflare.com`); fixed with shared `stripUrls()` / `isFilePathLike()` (rejects TLD ends) / `extractFileLikeTokens()` in `js-identifiers.ts`, used by BOTH `auditor.ts` and the hallucination factual check so they can't drift; `suppressRepetitionRetry` in `agent.ts` — when the final audit gate rejects an answer and re-prompts, the model's naturally repetitive re-answer is downgraded to a warning and flows back to the audit gate (bounded by `MAX_AUDIT_RETRIES`) instead of burning the hallucination budget (was: audit loop → "too repetitive" retries → `response_blocked` on a completed task).
