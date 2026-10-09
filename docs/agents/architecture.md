# Architecture & Design

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

### Output Architecture

> **Spec/plan:** `docs/superpowers/plans/2026-09-18-output-architecture-refactor.md`

All terminal output flows through `src/output/` as events, so the mode of the
terminal (streaming / modal / quiet) and every machine surface see the same data.

- **Modules:** `types.ts` (`OutputEvent`, `OutputSubscriber`, `OutputSink`),
  `bus.ts` (`OutputBus` + `defaultOutputBus`), `channel.ts` (`OutputChannel`,
  `getDefaultChannel`), `format.ts` (`formatEventLine`), `machine.ts`
  (`writeMachineJson`), `json-sink.ts`, `session-sink.ts`.
- **Event flow:** producers (`Logger`, `Renderer`, `Spinner`, REPL, CLI, tools)
  call `defaultOutputBus.log()` / `emit()`; `OutputBus` fans out to subscribers —
  `OutputChannel` (the sole terminal writer) plus `JsonOutputSink` and
  `SessionOutputSink`.
- **Ownership-mode state machine:** `OutputChannel` is always in one of
  `idle | streaming | modal | quiet`. `idle` hands `log`/`block` lines to the
  active prompt (`PromptSink.printAbove`, batched via a microtask) and routes
  `raw` through a partial-line buffer; `streaming` passes writes straight through
  and closes an open partial line before a `log`; `modal` queues events and
  flushes them FIFO on `endModal`; `quiet` (set by `--json`) drops human output.
  The REPL transitions the channel around each agent run and each interactive
  tool. Exactly one production channel exists per process (`getDefaultChannel()`).
- **Prompt coordination:** `LineEditor` implements `PromptSink`
  (`printAbove`/`isActive`/`clearScreen`); `suspendFrame`/`resumeFrame` and
  `setInputEnabled` let the agent own the terminal during a stream.
- **Internal diagnostics:** `Logger.diagnostic(level, msg, meta)` emits the same
  log event with `data.diagnostic = true` (file logging is unchanged).
  `OutputChannel.setShowDiagnostics(show)` — off by default — drops those events
  in `onEvent`, so loop internals (hallucination retries, audit/compaction notes,
  repeated-tool nudges, critic/MoE internals) reach the chat only when
  `ui.verbosity === "verbose"`; `webui/log-forward.ts` forwards the flag and the
  client gates the line the same way. User-facing notices (prompt overflow,
  provider build errors, killed processes) keep using plain `warn`/`info` and are
  always shown.
- **Guard:** `tests/output/no-direct-console.test.ts` parses `src/` and
  `examples/` with the TypeScript AST and fails on any `console.*` or
  `process.stdout/stderr.write`, except the documented allowlist (crash-handler,
  `output/machine.ts`, browser bridge child process, non-TTY REPL fallback).

### Host Seam (REPL / Web)

> **Source:** `src/core/host.ts`, `src/core/web-host.ts`, `src/modules/webui/`. Design: [docs/specs/2026-09-23-mma-web/design.md](../specs/2026-09-23-mma-web/design.md).

`Host` (`src/core/host.ts`) extends the plugin-facing `HostBridge`
(`{isBusy, submit(text,{images}), interrupt, subscribeOutput}`) with
`executeCommand(line)` + `getState(): HostStateSnapshot` — the extra surface web
mode needs (slash commands, sidebar/topbar snapshot).

- **Two implementations over one `Agent`:** `Repl` (terminal, owns `LineEditor`)
  and `WebHost` (`src/core/web-host.ts`, no TTY). Both submit through the SAME
  `runAgent` path as terminal input — rendering, session logging and the
  single-flight guard are shared, never duplicated.
- **WebUi module** (`src/modules/webui/`): `state.ts` (shared mutable state +
  single-flight reservation), `server.ts` (SSE `/events` + REST routing +
  static assets), `forward.ts` (agent callbacks → SSE), `module.ts` (the only
  place that knows about `Agent`; builds `WebHost`), `commands.ts` +
  `memory-commands.ts` (browser slash-command handler map), `config-api.ts`,
  `settings-api.ts` (memory/skills/plugins), `sessions-api.ts`, `history-api.ts`
  (REST route handlers), `assets.ts`, `util.ts`.
  App creation is separated from `listen()` (rule #13), so tests bind no port.

### Frontend Seams (what a new frontend must implement)

> **Source:** `src/cli/command-context.ts`, `src/core/commands/{catalog,spec}.ts`, `src/core/host-state.ts`.

The seam a **new frontend** (e.g. a full-screen TUI) has to satisfy. Three
pieces, each frontend-agnostic and shared by REPL / TUI / web / serve:

| Seam | Contract | Notes |
| --- | --- | --- |
| Host snapshot | `buildHostState(input, busy)` (`src/core/host-state.ts`) | Was in `webui/host-state.ts`; `serve` already imported it from there. Any host renders the same 22-field `HostStateSnapshot`. |
| Commands — services | `CommandServices` | Config/agent/modules. Identical everywhere; no IO. |
| Commands — IO | `CommandOutput` (print), `CommandInput` (ask) | The only frontend-specific surface a command sees. |
| Commands — catalog | `COMMAND_CATALOG` + `CommandRegistry` | *What* commands exist. Actions stay per-frontend. |

- **Adding a frontend** = implement `CommandOutput` (2 required methods) +
  `CommandInput` (3 methods), bind handlers onto the shared catalog, and reuse
  `buildHostState` for the snapshot. No command bodies change.
- **Actions are not unified on purpose.** Terminal prints ANSI via
  `OutputChannel`; web emits plain SSE lines. That difference is the
  `CommandOutput` adapter's job, so the catalog only answers "what exists" and
  each frontend declares which commands it can execute.
- **`isAvailable` defaults to terminal + TUI** when a command declares no
  `surfaces`. Enumerating TUI 29 times would silently drop commands later.
- **Anti-drift guards:** `tests/core/command-catalog.test.ts` (catalog ↔ REPL
  registrations, both directions; web-marked commands ↔ real web dispatcher) and
  `tests/cli/repl-help.test.ts` (user-visible `/help` output).

### Session Auto-Naming

> **Source:** `src/modules/session/auto-name.ts`, `src/core/agent.ts` (`Agent.run`).

Every session is named from the first user message through one cross-transport
hook in `Agent.run()` (so REPL, web and one-shot all behave the same):

- **Deterministic first** — `deriveSessionName(input)` produces an instant name
  (first non-empty line, markdown/code/url stripped, capped at 60 chars).
  `SessionManager.rename(id, name, "auto")` records provenance in
  `SessionMeta.nameSource` (`default` | `auto` | `manual`).
- **LLM refinement second** — unless `config.session.autoName === false`, a
  fire-and-forget `generateSessionTitle` call (8s timeout, fail-open) refines
  the title and stores it only when the session is still `auto` and unchanged
  (stale-session guard).
- **Manual is sticky** — a session created with an explicit name or renamed by
  the user has `nameSource: "manual"` and is never overwritten.

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

#### Always-on: Protected-path confirmation (`src/modules/security/protected-paths.ts`)

Independent of `security.paths.enabled`, all file-mutating tools (`write_file`, `edit_file`,
`delete_file`, `move_file`, `create_dir`) refuse protected paths and return a directive telling the
model to **ask the user** for explicit confirmation:

- VCS internals: `.git/`, `.hg/`, `.svn/`
- Secrets/env: `.env*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.crt`, `*.secret`, `*.token`,
  `.npmrc`, `.netrc`, `.git-credentials`, `.gitconfig`

This is a **soft guard, not a hard block**: the user can still approve. The system prompt carries a
matching `PROTECTED PATHS` rule so the model asks before attempting the call (and does not work
around it with `bash`). Rationale: irreversibly deleting `.git/config` or rewriting `.env`/keys is a
data-loss risk even with the opt-in security module disabled.

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

- **Commands:** `mma model certify <name> [--provider-url <url>] [--tags core,security,image,network,browser,moe] [--scenarios <ids>] [--reps N] [--force] [--clean]`, `mma model cert-status <name>`, `mma model cert-list`, `mma model uncertify <name>`.
- **Targeted re-run:** `--scenarios <ids>` (comma-separated, case-insensitive) runs only those scenarios and MERGES the fresh results into the existing certification entry — previous results for non-rerun scenarios are preserved verbatim (`mergePartialResults()` in `cli.ts`). A partial run does NOT require `--force` (it's an incremental update); a full-suite re-run still does. Unknown ids abort with the list of available scenarios.
- **Per-rep timeout:** default 300s; override via CLI `--timeout <ms>` (run-level) or per-scenario `timeoutMs` (YAML + `CertScenario`, validated >= 1000). Priority: `scenario.timeoutMs` → `opts.timeoutMs` → 300_000. Scenario 3.5 ships with `timeoutMs: 600_000` — slow local reasoning models (~30-45s per LLM call, ~12 iterations) complete the task correctly but miss the old default (see docs/small-model-observations.md).
- **Audit gate vs exit-on-complete:** the harness runs the agent with `--exit-on-complete`; its fast-exit on a hallucination-retry-flagged first response does NOT bypass the final audit gate when a plan is active (`agent.ts`) — otherwise a model that answers "done" without finishing the plan passes silently.
- **Tags:** `core` (default, no external deps), `security` (requires config, applied per-scenario), `image`, `network`, `browser`, `moe`.
- **Per-scenario config:** scenarios can declare `config:` overrides that are deep-merged into the base config and written to the sandbox as `<sandbox>/.mma/config.json`. The spawned process reads it via `MMA_CONFIG_DIR` env var. This enables security/MoE/LSP testing without requiring the user's global config to have those features enabled.
- **Manifest:** **global** `~/.mma/certifications.json` — entries keyed by `(model, providerUrl)`, recording `mmaVersion`, suite summary, and per-scenario results. Certifications are machine-scoped (model+provider), not project-scoped: marks are visible from any working directory. A bundled copy ships with the package (`certification/certifications.json` in the repo → copied to `dist/certification/` by `scripts/copy-assets.ts`) and is synced into the global manifest at every startup (`syncGlobalManifest()` in `manifest.ts`, called from `bootstrap.ts`): on a package update the bundled entries overwrite their keys; user-local certifications for other keys are preserved. A snapshot file (`~/.mma/certifications.synced.json`) prevents rewrites between updates. Legacy per-project manifests (`<project>/certification/certifications.json`, git-tracked) are still read and merged into every display lookup (`readMergedManifest`); `uncertify` cleans both stores.
- **Checkmarks:** `mma model list` and REPL `/model` show `✔` (certified on this provider, MMA version matches), `○` (certified on an older MMA version — re-run `--force`), `·` (not certified).
- **Harness mechanics:** spawns `bun src/cli/main.ts` per scenario rep with `--no-agents-md --exit-on-complete -d <sandbox>`, injecting `(model, provider)` via the existing env overrides (`MMA_MODEL`, `MMA_PROVIDER_BASEURL`, `MMA_PROVIDER_APIKEY`, `MMA_CONTEXT_WINDOW`). Fact-checks: files, exit code, output substring (`outputContains` for security scenarios). M/N tally per scenario (default 2/3).
- **Source:** `src/modules/certification/` (`types`, `scenarios`, `loader`, `fact-checker`, `runner`, `manifest`, `cli`). It is an offline tool independent of the agent loop — never part of the system prompt or context.
- **Scenarios:** builtin in `scenarios.ts` (ported from `docs/testing/scenarios.md`); user-defined YAML in `<project>/.mma/certification/scenarios/*.yaml`. Image fixtures in `docs/testing/fixtures/`.

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

## Counter-Agent (In-Loop Critic)

> **Spec:** `docs/specs/2026-09-25-session-autoname-and-critic-design.md` §4.

An evidence-grounded, event-triggered LLM verifier ("counter-agent") that reviews the single agent's
in-progress work. It is a loop gate like `AuditGate`/`HallucinationGate` — the MoE path is untouched.

- **Modules:** `src/modules/critic/types.ts` (`CriticVerdict`/`CriticIssue`/`EvidencePack`),
  `evidence.ts` (`buildEvidencePack`, `isWorkMutation`), `client.ts` (`CriticClient`, `parseVerdict`,
  `CRITIC_SYSTEM_PROMPT`), `provider.ts` (`buildCriticProvider`), `tools.ts` (bounded read-only
  verification loop); the gate lives in `src/core/agent/critic-gate.ts` (`CriticGate`,
  `gatherTurnToolEvents`).
- **Trigger:** `enabled` + `criticCalls < maxCalls` + (before-finish OR `mutationsSinceCritic >= 3`)
  + at least one tool event in the turn. Work mutations are counted per tool call (`write_file`,
  `edit_file`, `delete_file`, `move_file`, `create_dir`, `bash`; `plan` is bookkeeping, not work).
- **Authority:** `concern`/`critical` inject a `<system-summary>` and return `retry` once per fresh
  issue (signature-deduped). `critical` before finish consumes one bounded repair cycle
  (`maxRepairCycles`); after the budget it degrades to advice. `ok`/null passes.
- **Fail-open:** the client catches provider errors/timeouts and returns `null` on unparseable JSON
  (repaired with `jsonrepair` first); the gate catches any verify throw. A broken critic can never
  block the agent.
- **Config:** `critic.{enabled,model,provider,tools,maxCalls,maxRepairCycles,timeoutMs}`
  (`src/config/defaults.ts`).
- **Observability:** `critic_check` / `critic_verdict` / `critic_escalation` entries in
  `session.jsonl` via `SessionLogger.logCritic`, plus a `Logger.diagnostic("info", …)` line that
  is visible on the terminal/web only at `ui.verbosity === "verbose"`. No chat surface renders
  the verdict: `Renderer.criticVerdict`, the SSE `critic` event and the UI callback were removed.
- **Phase 2:** dedicated critic provider (`critic.provider`/`critic.model` via `ProviderManager`,
  `src/modules/critic/provider.ts`; managed path only when `model` is set, broken overrides warn
  and fall back to the active provider) and a bounded read-only tool-loop (`critic.tools`, default
  true): after a concern/critical verdict the critic may request up to 3 checks
  (`read_file`/`grep`/`glob`/`file_info`/`list_dir`, `src/modules/critic/tools.ts`), executed through
  the shared `ToolExecutor` with a read-only allowlist, and the final verdict is grounded in their
  outputs. The sequence shares one verify timeout and fails open to the first-pass verdict.

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

### Правило 5: Обработка HTTP 429 (rate limit)

`fetchWithRetry` в `openai-compat.ts` ретраит 429/5xx с экспоненциальным бэкоффом. Для 429:

- **Уважение `Retry-After`** — если провайдер отдал заголовок `retry-after`, задержка берётся из него (с капом `maxDelay`), иначе экспоненциальный бэкофф. Free-модели (например `*-free` на OpenCode Zen) требуют реальной паузы — короткий бэкофф не помогает.
- **Понятное сообщение об ошибке** — если 429 сохраняется после всех ретраев, бросается `error.llm_429` (i18n, en+ru) с model/baseUrl и подсказкой: получить API-ключ или сменить модель. Агент показывает его как `Ошибка LLM: …` вместо голого `HTTP 429`.

### История проблемы

Агент создавал папку (первый tool_call), но на второй итерации модель возвращала пустой ответ. Агент уходил в hallucination retry и зацикливался. Диагностика:

1. `doStream` возвращал пустой стрим (ни text, ни tool_call) на второй итерации
2. Fallback `doNonStreaming` не вызывался из-за условия `&& reasoningAcc` (reasoning был пуст)
3. Даже когда fallback вызвали (после фикса условия), он падал с 400 из-за нарушения Jinja-шаблона (system не первый, отсутствует `stream: false`)
4. Non-streaming без tools работал, но с tools — падал с `400: System message must be at the beginning` или `No user query found in messages`

**Все фиксы сделаны в:** `src/core/agent.ts`, `src/llm/openai-compat.ts`, `src/modules/context/manager.ts`, `src/modules/hallucination/confidence.ts`.

---

### Model capabilities (single source of truth)

A model's `vision`/`tools` abilities are DATA, never guessed from the model name (rule #10). `resolveModelCapabilities` (`src/modules/providers/capabilities.ts`) merges, highest wins:

1. `config.modelCapabilities[model]` — manual override;
2. live native probe — `probeModel` (`src/llm/model-loader.ts`) reads `capabilities` from LM Studio `/api/v1/models`;
3. provider preset — `providers/presets.ts`.

Tools read the resolved value via the live `ToolContext.capabilities` getter (recomputed per access, so model/provider switches are visible without rebuilding the context). Tool-produced images (`ToolResult.images`) are delivered to the model as `image_url` parts through `queueToolImages` — never as base64 text inside `role:"tool"` content.

## Key Design Rules

1. **No file >300 lines** — split when approaching limit
2. **Small files, single responsibility** — each file does one thing
3. **KISS state machine** — no god objects, no if-else nesting in agent loop
4. **Single source of truth** — `config/defaults.ts` for config, `tools/registry.ts` for tools
5. **Plugin error isolation** — one plugin crash never stops others
6. **Path safety** — all filesystem tools validate resolved paths through `isInsideDir` / `isPathWritable` / `isPathInScope` (separator- and case-safe on win32; sibling prefixes like `docs` vs `docs-other` cannot pass). After a subagent call the parent's scope is restored EXACTLY (`undefined` stays `undefined` — an empty `{[],[]}` scope would deny everything).

### Known path-handling nuance (do not forget)

`safeResolvePath` (`src/tools/path-utils.ts`) "fixes" model typos like `E:\agent_test` → `E:\agent\_test` by walking ancestors and substring-matching directory names, and honors existing absolute paths as-is. This heuristic is intentionally risky: it can resolve a path outside baseDir (e.g. a bare `/foo` that exists on disk, or a substring match against an ancestor name). It is SAFE today only because every caller re-validates the returned path via `isPathInScope`/`isPathWritable` before touching the filesystem. **Rule: any new tool that uses `safeResolvePath` MUST re-validate the result with one of those two functions** — do not trust its return value alone. If this invariant breaks, prefer removing the heuristic over adding containment inside it.
7. **TDD** — write test first, then implement, then commit
8. **No hardcoded user-facing strings** — ALL text shown to users MUST go through `t()` from `i18n/index.ts`. Both `en.json` and `ru.json` must have matching keys. No exceptions — CLI labels, error messages, tool outputs, REPL prompts, setup wizard text, everything.
9. **No full-screen TUI** — no alternate screen buffer, no raw-mode, no full-frame redraw. Rich ANSI output is allowed: spinner (single-line `\r` overwrite on stderr), boxed tool cards, aligned tables. Auto-degrades to plain text when `!isTTY` or `CI`.
10. **No keyword matching for task classification** — determining whether a task is multi-step, needs planning, or requires specific tools via keyword/word matching is an anti-pattern. It fails for non-English languages, ambiguous inputs, and novel task patterns. Instead, use the system prompt to instruct the model to use the `plan` tool when appropriate. The model decides whether to create a plan based on task complexity, not hardcoded heuristics.
11. **Interactive tools bypass the execution timeout** — tools that block on user input (`question`, `approve`) must set `interactive: true` on their `ToolDefinition`. The executor skips the 60s timeout for them. Any new user-facing interactive tool must do the same, and must reuse `user-input.ts` instead of creating its own readline interface.
12. **No static imports for build-time values** — never use a static import to load a value that a bundler resolves at build time (package version, build metadata). Bundlers inline it with a stale value. Always read it from disk at runtime. (Concrete repo case: read `package.json` via `readFileSync` + `fileURLToPath(import.meta.url)` with path candidates for both source `src/cli/` and bundled `dist/` layouts — see `readVersion()` in `src/cli/commands.ts`.)
13. **Separate app creation from server start** — when creating a web server (Express, FastAPI, Go http, etc.), always export the app/handler object separately from the `listen()` call. This allows tests to import and test the app without binding to a port. Pattern: create app → export app → if main module, call listen().
14. **No silent error swallowing — ЗАПРЕЩЕНО** — никогда не писать `catch {}`, `catch { return ... }` без логирования или `.catch(() => {})` / `.catch(() => null)` без логирования. Каждая подавляемая ошибка ДОЛЖНА попасть в logger (`logger.debug`/`logger.warn`) с контекстом (что делали, почему подавление безопасно). Молчаливое глотание делает сломанный код неотличимым от работающего и убивает диагностику по session-логам. Исключений нет: даже «гарантированно неважные» реджекты (например, проигравшие промисы в `Promise.race`) логируются перед сбросом. Пустой `catch {}` допустим ТОЛЬКО если рядом строкой есть комментарий с обоснованием И вызов logger внутри catch-блока.
15. **Комментарии в коде — на русском** — все комментарии в исходниках (`src/`, `tests/`, `scripts/`) пишутся на русском языке: назначение, инварианты, «почему» и предупреждения. Не переводятся: идентификаторы, ключи/поля API, строки протокола и цитаты внешних форматов — они остаются в оригинале (например, `prompt_tokens_details.cached_tokens`). Пользовательские строки по-прежнему только через `t()` (правило #8); комментарии — не пользовательский вывод.
16. **Кросс-платформенность (Windows / macOS / Linux)** — код, работающий с процессами, путями, шеллами и ФС, обязан работать на всех трёх ОС. Запрещено опираться на платформо-специфичные примитивы без ветвления или фолбэка:
    - **Пути:** только `path.join`/`path.resolve`/`path.sep`/`path.dirname` — никогда ручная сборка через `\` или `/`.
    - **Симлинки:** `fs.symlinkSync(target, path, "junction")` (на Windows — junction без прав администратора, на macOS/Linux — обычный symlink). Не вызывать `mklink`/`ln` через shell.
    - **Запуск процессов:** учитывать Windows-стабы (`.cmd`/`.ps1` vs шебанг), квотировать пути с пробелами; не полагаться на `node`/`npx` в `PATH` — резолвить локальный бинарь и запускать текущим рантаймом (`process.execPath`). **`npx` для локальных инструментов запрещён** (медленно и лезет в сеть) — см. `resolveTscCommand` (`src/modules/lsp/project-root.ts`).
    - **ОС-детект:** `os.platform()`/`process.platform`, а не проверки строк путей.
    - **Тесты:** если примитив не поддерживается ОС (права, ФС), тест должен **скипаться**, а не падать; уборка ресурсов — с ветвлением по платформе.
    - Учитывать регистрозависимость имён файлов (Linux) и переводы строк CRLF/LF.
17. **Диспетчеризация подкоманд — через карту хендлеров** — REPL/CLI-команды с несколькими подкомандами (`/provider`, `/model`, `/skill`, `mma provider …`) НЕ строятся на цепочке `if (subcmd === "…")`: она не масштабируется, дублирует вывод `usage` и легко теряет `return`. Используй карту `Record<string, (args: string[]) => void | Promise<void>>` и единый резолв (`subcmd ? handlers[subcmd] : handlers[<default>]`), а общий парсинг аргументов и `usage`-фолбэк держи в одном месте. Разовое ветвление по флагу допустимо, длинная цепочка подкоманд — нет. Пример: `registerProviderCommands` (`src/cli/repl-commands.ts`).
18. **Стиль кода — по `docs/agents/code-style.md`** — единый стандарт: запрет `as any`/`as unknown as X` (кроме test seams с комментарием), `import type`, явные типы возврата у экспортов, прерываемые ожидания с проверкой `abort`, никаких молчаливых `catch`, комментарии на русском (#15), постепенное ужесточение tsconfig. Отклонения — только с комментарием-обоснованием.

## Project Structure

```
src/
├── core/               # Agent loop + prompt builder + types
│   ├── agent.ts        # State machine (INIT→THINK→ACT→OBSERVE→OUTPUT→ERROR)
│   ├── prompt-builder.ts # Collect PromptBlock[], sort by priority, fit 8K budget
│   ├── environment.ts  # Startup env report (OS/runtime/engines/tools/playwright) + requirement warnings
│   ├── crash-handler.ts # Global uncaughtException/unhandledRejection → ~/.mma/logs/crash.jsonl
│   ├── host.ts         # Host seam (HostBridge + executeCommand/getState) shared by Repl and WebHost
│   ├── host-state.ts   # Live state → HostStateSnapshot projection (was in webui/; shared with serve)
│   ├── commands/       # Declarative slash-command catalog (spec.ts = data, catalog.ts = registry)
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
│   ├── pricing/        # Cost tracking + display (budget/tariff)
│   │   ├── prices.ts   # Builtin Zen/Go price table (USD/1M tokens) + calculateCost/formatCost
│   │   └── index.ts    # CostTracker — accumulate per-LLM-call cost for a session
│   ├── skills/         # Skills loader (builtin/global/project) + progressive disclosure L1/L2/L3
│   ├── plugins/        # PluginManager with lifecycle hooks + error isolation
│   ├── mcp/            # MCP client (stdio/SSE) + server registry
│   ├── pipelines/      # DAG-based workflow engine (YAML → execute)
│   ├── indexer/        # Automatic project map: file walker + export extraction + disk cache
│   │   ├── walker.ts   # Recursive walker, language detection, export extraction
│   │   ├── cache.ts    # JSON cache of index results
│   │   └── module.ts   # AgentModule — PromptBlock + project_map tool + watch plugin
│   ├── lsp/            # LSP diagnostics (typescript/css/html/json/python/rust/go + angular), on-demand + write/edit plugin
│   │   ├── module.ts   # AgentModule — lsp_check tool + onAfterTool plugin (per-server disable, cap 40)
│   │   ├── check-tool.ts # lsp_check helpers: collectCheckFiles (dir walk, cap 15) + formatCheckDiagnostics
│   │   ├── probe.ts    # probeLspServers — REPL banner: which servers apply to the project + do they start
│   │   ├── client.ts   # LSP over stdio (spawn, initialize, didOpen, shutdown) + probe()
│   │   ├── command.ts  # resolveSpawnCommand + buildWinCommandLine (win32 shell)
│   │   ├── config.ts   # Per-language server config (command/args/workspaceMarkers); `.html` routes to the `angular` server (`ngserver` from `@angular/language-server`, workspaceMarkers: `angular.json`) inside Angular workspaces, generic html server elsewhere
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
│   ├── updater/        # Self-update: async GitHub-Release check + auto-install
│   │   ├── release.ts   # Shared base URL, platform keys, manifest schema
│   │   ├── checker.ts   # Updater.check() (manifest fetch) + install() orchestration
│   │   ├── install-release.ts # download + sha256 + extract + flip ~/.mma/current
│   │   └── module.ts    # UpdaterModule — fire-and-forget background loop, autoInstall
│   ├── user-profile/   # OS/shell/preferences → ~500 token compressed block
│   ├── webui/          # `mma web` browser mode: state + SSE/REST server + forwarder + module (assets)
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
│   ├── web-command.ts  # `mma web` entry point (bootstrap → browser UI → signal wait)
│   ├── web-host.ts     # WebHost — Host implementation without a TTY
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
