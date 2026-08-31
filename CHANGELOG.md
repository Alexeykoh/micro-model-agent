# Changelog

All notable changes to Micro Models Agent (MMA) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **MoE hang**: sub-agents spawned by the `subagent` tool re-entered `runWithMoE` when the parent config had `moe.enabled=true` — each MoE sub-agent planned its own subtasks and spawned nested sub-agents recursively (bounded only by `maxRecursionDepth`), hanging execution for many minutes with zero progress events. Sub-agents now always run the plain single-agent loop (`moe` is a top-level orchestration mode only).
- **MoE fallback visibility**: missing `orchestrator.model` with `moe.enabled=true` now logs a WARN with a fix hint instead of a debug-only message that made silent fallback to single-agent invisible.
- **Docs**: AGENTS.md / testing.md — warn that `mma` resolves the globally installed package (stale `dist/`) when run outside the repo root, silently ignoring `src/` changes; always run from the repo root with `-d <sandbox>` and verify the version in the `Environment:` line.

## [0.58.0] - 2026-08-31

### Added
- **MoE experts**: dynamic expert registry — `config.experts` (with optional `ExpertConfig.description`) is rendered into the MoE planner prompt instead of a hardcoded code/research/browser/vision list (fallback: `tool_tags`)
- **MoE orchestrator provider**: `OrchestratorClient` builds its provider through `ProviderManager` — per-entry `contextWindow`/`retry`/`rateLimits` and failover entries are honored; `orchestrator.contextWindow` is the global fallback (legacy `{type,baseUrl,apiKey}` configs keep working)
- **MoE success criteria**: machine-readable `success_criteria` (`file-exists:<path>`, `substring-in-file:<path>:<text>`, `command-exit-0:<cmd>`) verified by `StepVerifier.verifySubtaskCriteria` before merge; LLM-only criteria surface as warnings in the Router context
- **MoE selective re-plan**: `executePlan(plan, {skipIds, carriedResults})` — already-succeeded subtasks are carried over across re-plan cycles, only failed/new subtasks re-execute
- **MoE observability**: `moe_plan` / `moe_subtask` / `moe_replan` / `moe_verify` events written to `session.jsonl` (visible in `mma session show`); token usage aggregated per `expert_tag` (`MoEExecutor.getUsageByTag`); sub-agents receive the real session id instead of the hardcoded `"moe"`
- **MoE cert scenarios**: `5.2-moe-parallel-waves` and `5.3-moe-read-after-write` (tag `moe`, timeoutMs 600_000)
- **ToolResult.usage**: sub-agent token usage propagated to the MoE executor for cost attribution

### Fixed
- **Tests**: replaced process-global `vi.mock` with DI seams (`AgentDeps.runWithMoEOverride`, `ToolContext.agentFactory`) — Bun module mocks leak across test files in the same worker; full suite is now green by default (1799 pass / 0 fail)

## [0.57.2] - 2026-08-30

### Changed
- **KV-cache**: plan block removed from system prompt; plan status now injected into `<system-summary>` envelope after every tool batch. System prompt is immutable per session — local backends retain prefix cache.
- **Provenance**: provider entry resolution uses active entry label, not bare `provider.type`
- **Reasoning signals**: `consecutiveToolSuccesses` and `isRepetitive` now feed real values to the reasoning policy (were hardcoded)
- **Token estimation**: tool-def token estimate in agent loop uses `estimateTokens()` instead of flat `/4`
- **Agent split**: `agent.ts` 1550→950 lines; 10 extracted modules (`loop-state`, `compaction`, `tool-batch`, `hallucination-gate`, `audit-gate`, `reasoning-resolver`, `token-tracker`, `context-renderer`, `tool-output`, `constants`)
- **Plan-tool**: `plan-tool.ts` 741→232 lines; per-action handlers in `plan-actions.ts`
- **CLI**: `createProgram` 513→thin orchestrator; `registerMmaCommands` 470→8 lines (5 per-domain registers)
- **Bash handler**: `bash.ts` 236→~100 lines (`resolveBashSecurityConfig`, `decorateCommandOutput`)
- **Orchestrator**: reuse `parseChunks` instead of hand-rolled `any[]` aggregation; `createPlan` uses own `parseJSON`; constructor deduplicated via `createProviderInstance`
- **Shared utils**: `src/utils/` with `errMsg()`, `sleep()`, `truncate()`, `backoffDelay()`
- **errMsg**: replaces 23 occurrences of `e instanceof Error ? e.message : String(e)` across 12 files

### Fixed
- **chunk_query**: one failing chunk no longer kills the entire query; per-chunk `catch` → `[FAILED]`
- **chunk_query**: synthesis prompt capped at 20K chars with `[TRUNCATED]` marker
- **chunk_query**: `AbortSignal` propagated to `chatText` for cancellation support
- **Executor**: `failFast` cleanup guard prevents nested scope clobbering
- **probe.ts**: transient errors (network/auth) no longer cached as "reasoning not supported" for 24h; returns `null` → caller skips cache
- **LSP**: startup timeout unified on `DEFAULT_TIMEOUT` (15000) instead of conflicting hardcoded 10000
- **Browser**: `BridgeResponse.data` typed (was `any`)
- **Agent**: `Agent.runTool()` public API replaces `(ctx.agent as any).deps` reach-in; `/reload` no longer mutates readonly context
- **LSP /lsp check**: fixed latent bug where `.execute()` was called with `.executeByName` signature

### Added
- **Plan Reminder**: static `[Plan Reminder]` block in system prompt (never mutates)
- **Documentation**: reentrancy warning on `executeByName()`, `PlanResult` JSDoc
- **Tests**: `probe.test.ts` (6 cases), `command-suggest.test.ts`, `providers-factory.test.ts`, `subagent-tool.test.ts`, `agent-moe-write.test.ts`, `chunk-query.test.ts`
- **probe.ts**: `null` return for transient errors; bootstrap skips cache on `null`
- **Execution-plugin**: `resetStepFlags`/`resetPlanState` helpers (dedup 3 inline reset blocks)
- **Security-policies**: `comparePolicies` typed (`keyof SecurityConfig` replaces `as any`)

### Removed
- **Browser**: dead `buildWaitScript` export (never imported)

## [0.57.1] - 2026-08-28

### Fixed
- **Publish**: republish after version bump

## [0.57.0] - 2026-08-28

### Changed
- **MCP**: lazy connect — server connections deferred to first tool call. Startup no longer blocks on unreachable MCP servers (e.g. context7 offline). Discovery runs in background with 5s timeout.
- **Updater**: `checkOnStart` and `autoInstall` disabled by default. Reduced `waitForIdle` timeout from 130s to 10s.
- **Config**: `updater.checkOnStart` default changed from `true` to `false`

### Added
- **MCP**: HTTP request timeouts (10s) on `connectSSE`, `listToolsHTTP`, `callToolHTTP`
- **MCP**: `failedServers` tracking — servers that fail discovery are not retried
- **MCP**: placeholder `connect` tool for not-yet-discovered servers (LLM can trigger lazy discovery)
- **Reasoning**: persistent disk cache (`~/.mma/reasoning-cache.json`) with 24h TTL — avoids re-probing LLM on every restart

## [0.56.5] - 2026-08-27

### Fixed
- **Hallucination**: `FactualCheck` now receives deleted files from `ConsistencyCheck` — no longer false-positives on files that were intentionally deleted in the same session

## [0.56.4] - 2026-08-27

### Fixed
- **Tools**: `list_dir` now filters `.mma/`, `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/` from directory listings (consistent with indexer)
- **Hallucination**: `dotfileVariants` now tries dot-prefixing each directory component, not just basename (fixes false positive on `.mma/index-cache.json` → `mma/index-cache.json`)

## [0.56.1] - 2026-08-27

### Added
- **CLI**: `mma changelog` command — show latest changelog entry or diff between versions (`--from <version>`)
- **Updater**: show changelog after auto-update install (`updater.installed` message includes new version's changelog)
- **Docs**: `CHANGELOG.md` included in npm package (visible via `npm info micro-models-agent`)
- **Docs**: rule to maintain changelog in `AGENTS.md`

## [0.56.0] - 2026-08-27

### Added
- **MoE**: live re-plan loop in `runWithMoE` — orchestrator re-plans on structural failures
- **MoE**: scope expansion protocol (`scope_request`) for cross-expert file access
- **MoE**: Esc/interrupt support in the MoE execution path
- **MoE**: `input_from` cross-expert data flow for subtask dependencies
- **LSP**: Angular language server support (`@angular/language-server` for `.html` in Angular workspaces)
- **Tools**: syntax pre-validation and auto-fix for `write_file`/`edit_file`

### Fixed
- **Security**: SSRF via IPv6-mapped IPv4 and raw numeric hostnames
- **Security**: command-validator blacklist bypasses (shell expansions, encoded chars)
- **Security**: audit webhook retry queue drained forever (infinite loop + duplicate notifications)
- **Core**: dangling `tool_calls` on interrupt — synthesized tool messages keep assistant/tool pairing
- **Core**: live reasoning policy + `set_thinking` override integration
- **Core**: deep-clone config defaults to prevent cross-session mutation
- **Config**: preserve `provider.fallback` on hot-swap
- **Tools**: path/scope escape holes in filesystem and read tools closed
- **Tools**: clear timeout timer & abort listener after race settles; log discarded losers
- **MCP**: stdio timer leaks + null deref after disconnect; added initialize handshake
- **LSP**: spawn servers detached on POSIX so `killTree` reaches the whole chain
- **Browser**: bridge leaked Chromium on SIGTERM and parent death
- **UI**: diff LCS memory cap; one bad encrypted line no longer kills session history
- **CLI**: `/config migrate` was unreachable
- **MoE**: locale-independent artifact path + no retry on user abort

## [0.55.1] - 2026-08-25

### Fixed
- **LLM**: NDJSON-tolerant stream parser for Ollama backends
- **LLM**: mid-stream provider errors surfaced (Ollama generation failures)
- **LLM**: `delta.reasoning` alias for thinking models
- **LLM**: wire-level debug logging for diagnostics

## [0.55.0] - 2026-08-25

### Added
- **Certification**: targeted re-run (`--scenarios <ids>`) with result merging
- **Certification**: per-rep timeout (`--timeout <ms>` + per-scenario `timeoutMs`)
- **Certification**: audit-gate bypass fix for `--exit-on-complete`

### Fixed
- **Certification**: stale-label wording (removed impossible user instruction)
- **Dependencies**: typescript pinned to ^5.9 (TS7 preview breaks `@types/node`)

## [0.54.0] - 2026-08-24

### Added
- **Certification**: global manifest shipped with package updates (`~/.mma/certifications.json`)
- **Certification**: bundled manifest + startup sync from package

### Fixed
- **Certification**: marks only showed when running from repo root

## [0.53.0] - 2026-08-24

### Added
- **Certification**: qwen3.5-9b certified 20/20
- **Config**: `provider.maxCompletionTokens` option
- **Certification**: label text in `mma model list` and REPL `/model`

### Fixed
- **Certification**: reasoning-heavy models truncated tool_call arguments at default 4096 cap
- **Certification**: scenario 3.5 prompt disambiguation

## [0.52.0] - 2026-08-23

### Added
- **Execution**: `FS_MUTATING_TOOLS` — plan auto-advance after bash/download/subagent/mcp/pipeline/browser tools
- **Config**: `provider.maxCompletionTokens` plumbing through ProviderManager → agent

### Fixed
- **Execution**: small models create files via bash instead of `write_file`, stalling plans
- **Execution**: `maxCompletionTokens` was never read from config

## [0.51.0] - 2026-08-23

### Added
- **Plugin**: `HostBridge` interface for bidirectional agent communication
- **Plugin**: `onTurnEnd(ctx, TurnSummary)` hook — dispatched once per completed run
- **Plugin**: `web-ui` example plugin — browser-based chat with SSE streaming
- **CLI**: REPL bridge wiring for web-ui submit/interrupt

### Fixed
- **REPL**: `/config migrate` unreachable

## [0.50.3] - 2026-08-22

### Fixed
- **UI**: REPL line editor scroll-proof rendering (absolute anchoring via DSR query)

## [0.50.2] - 2026-08-22

### Fixed
- **LLM**: idle stream timeout increased 60s → 180s (LM Studio buffering)
- **LLM**: stall diagnosis with dedicated message for SSE buffering
- **LLM**: truncation no longer masquerades as empty response
- **LLM**: recoverable LLM errors fed back into context instead of dying
- **Execution**: bash flailing detector (≥4 failed bash attempts in last 6)

## [0.50.1] - 2026-08-21

### Fixed
- **Security**: no longer silently overrides explicit user opt-out
- **Lint**: skips missing lint binary (was appending error to every write)
- **Stuck**: anti-spam for stuck-warnings (dedup via key, decay per-tool counters)
- **Plan**: unified progress counting (done+skipped as settled)
- **Plan**: bulk `steps[]` rewrite guarded on progressed plans
- **Plan**: archived plans answer read-only
- **Process**: usage hints for `process_kill`/`process_log` without id

## [0.50.0] - 2026-08-21

### Added
- **Provider**: health probe (`probeProviders()` + `mma provider check`)
- **Provider**: code-only capability routing (`ProviderManager.pickFor()`)
- **Provider**: per-entry isolation + priority fallback order
- **Pricing**: per-provider cost attribution + breakdown

### Fixed
- **Provider**: transparent failover on 429/5xx/network errors

## [0.49.0] - 2026-08-20

### Fixed
- **REPL**: stale-plan leaks — plan state no longer persists across sessions
- **REPL**: plan checklist prints only on plan/todo tool-end events
- **Plan**: `PlanStore` is single source of truth for UI consumers

## [0.48.3] - 2026-08-20

### Fixed
- **Hallucination**: dotfile false-positive (`.prettierrc.json` extracted as `prettierrc.json`)

## [0.48.2] - 2026-08-20

### Fixed
- **REPL**: stale plan printed on first agent run of a session

## [0.47.0] - 2026-08-19

### Added
- **Session**: startup diagnostics logging (environment, LSP probe, baseline typecheck)
- **Session**: `logBaselineTypecheck()` for post-mortem visibility

## [0.46.1] - 2026-08-19

### Fixed
- **LLM**: connection-break hardening (stream-level retry, no-data timeout, `[DONE]` tracking)
- **LLM**: non-streaming timeout (was missing, could hang forever)
- **Config**: `retry.maxStreamRetries`, `retry.noDataTimeoutMs` options

## [0.46.0] - 2026-08-19

### Added
- **Provider**: multi-provider + hot-swap + per-message provenance
- **Provider**: `ProviderManager` with entry-based config
- **CLI**: `mma provider add/list/use`
- **REPL**: `/provider list/use`

### Fixed
- **Path**: `safeResolvePath` POSIX bug (absolute paths re-resolved against baseDir)

## [0.45.0] - 2026-08-18

### Added
- **Provider**: provider module Phase 1 (registry, presets, `createProvider()`)
- **Provider**: `openrouter` preset
- **Setup**: wizard menu built from `BUILTIN_PROVIDERS`

## [0.44.0] - 2026-08-18

### Added
- **Plugins**: folder plugins (subdirectory with entry file)
- **Plugin**: `trace-server` split into folder plugin

### Fixed
- **Plugin**: template-literal page inlining broke `\n` in JS strings

## [0.43.2] - 2026-08-17

### Fixed
- **Execution**: plan done-gate on known compile failures (typecheck gate)
- **Bootstrap**: live getters for `sessionId`/`sessionContext` after session switch
- **Edit**: `edit_file` "String not found" hint to `read_file` first

## [0.43.1] - 2026-08-17

### Fixed
- **Agent**: session-interrupt no longer renders tool results after "Session ended"
- **Executor**: `onAfterTool` plugins skipped when signal is aborted
- **Lint**: abortable syntax checks on Esc

## [0.43.0] - 2026-08-17

### Added
- **Plan**: `plan delete <id>` + `plan purge` actions
- **Plan**: `abort` honors `id` parameter
- **Plan**: `replan` renumbers ids for kept steps
- **Audit**: `resolveTestCommand` picks the project's real test runner

### Fixed
- **Plan**: `switch` to already-active plan is a no-op
- **Plan**: final audit runs for a completed plan
- **Plan**: evidence-based plan nudge (replaces iteration counter)
- **Plan**: `checkPlanAlignment` scans path arguments only
- **Plan**: `isDepsStep` requires a package-manager verb
- **Plan**: auto-advance resolves nested files

## [0.42.0] - 2026-08-16

### Added
- **Execution**: automatic error web search (≥5 same-error repeats → web search → inject results)
- **Config**: `errorWebSearch` section

### Fixed
- **Execution**: `onAfterTool` double-counted typecheck + failure errors

## [0.41.1] - 2026-08-16

### Fixed
- **LSP**: `typescript@5` pin + `--yes` for npx
- **LSP**: sequential probing (waves) to avoid npx cache lock contention
- **LSP**: stale config normalization
- **LSP**: Windows process leak in `shutdown()`
- **REPL**: non-blocking LSP banner
- **Bootstrap**: lazy startup health check

## [0.41.0] - 2026-08-15

### Added
- **REPL**: live plan checklist with progress bar
- **UI**: tool-to-step binding (`← step N` suffix in tool headers)
- **UI**: background command output preview

## [0.40.1] - 2026-08-15

### Fixed
- **LSP**: broken package names (`vscode-html-languageserver` → `vscode-langservers-extracted`)

## [0.40.0] - 2026-08-15

### Added
- **Tools**: tool-set narrowing (on-demand enable via `enable_tools`)
- **Config**: `tools.defaultTags` + `tools.enableOnDemand`
- **Tools**: `alwaysOn` flag for structural tools

## [0.39.1] - 2026-08-14

### Fixed
- **Plugins**: dedup by version, compatibility gate, source tracking
- **CLI**: `mma plugins list` command

## [0.38.0] - 2026-08-14

### Added
- **LSP**: `lsp_check` tool for on-demand diagnostics
- **Plan**: `plan create` guard (blocks when active plan has progress)

### Fixed
- **Context**: compaction summary carries plan + read state
- **Browser**: bridge path resolution in bundled dist

## [0.37.0] - 2026-08-13

### Added
- **Plugins**: folder plugin support in `PluginLoader`

### Fixed
- **Plugin**: template-literal page inlining broke `\n` in JS

## [0.36.3] - 2026-08-13

### Fixed
- **UI**: REPL paste fix (batch single-render, CRLF collapse)

## [0.36.2] - 2026-08-13

### Fixed
- **Updater**: silent logger, one-shot `process.exit()` killed background install, semver-aware check

## [0.36.1] - 2026-08-13

### Fixed
- **Audit**: nested-file resolution, non-zero test run blocks
- **Browser**: bridge diagnostics + one-shot restart
- **LSP**: per-server disable + initialize retry + CSS timeout
- **Bash**: npm exec hint

## [0.36.0] - 2026-08-12

### Added
- **Plan**: model-declared `kind: "create"|"delete"` for steps
- **Execution**: `FS_MUTATING_TOOLS` for plan auto-advance
- **Config**: `provider.maxCompletionTokens` option

### Fixed
- **Context**: compaction preserves session `mission`
- **Context**: deleted files leave compaction `[Files:]` list
- **Audit**: final audit runs real `tsc --noEmit --skipLibCheck`
- **Bash**: repeated forbidden Windows commands hard-stopped after 2 failures

## [0.35.5] - 2026-08-12

### Fixed
- **Execution**: plan-alignment phantom paths (domains/extensions treated as files)
- **Execution**: hint/recovery dedup in `StuckDetector`

## [0.35.3] - 2026-08-11

### Fixed
- **LSP**: workspace root resolved from edited file's project
- **Audit**: skipped steps treated as terminal
- **Bash**: Windows hint keys on original command word
- **Tools**: boundedOutput tools never budget-truncated

## [0.35.0] - 2026-08-11

### Added
- **Tools**: `download_file` tool for binary file downloads

## [0.34.0] - 2026-08-10

### Added
- **Indexer**: project profile (`[Stack: ...]` summary from manifest)
- **Indexer**: dynamic map refresh inside sessions

## [0.33.3] - 2026-08-10

### Fixed
- **Audit**: nested-file resolution (basename + path-suffix match)
- **Plan**: `plan show` honors `id` parameter
- **Context**: compaction interval reset per user turn
- **Context**: `extractFacts` captures `edit_file` paths + Windows drive-letter paths
- **Execution**: stuck detector read-only loop detection
- **Read**: default limit 15 → 300 lines
- **LSP**: `spawn` on Windows (`.cmd` shim resolution)
- **Todo**: `todo add` tracks subtasks, `todo done` marks individual sub-task
- **Memory**: learns repeated per-tool failures (≥3×)
- **Context**: compaction preserves user's task

## [0.33.2] - 2026-08-09

### Fixed
- **UI**: REPL conversation layout (user/agent message dividers)
- **Tools**: `isFilePathLike` uses allow-list of file extensions

## [0.33.1] - 2026-08-09

### Fixed
- **UI**: REPL line editor redraw fix (no duplicated multi-line input)
- **Tools**: `web_fetch`/`web_browse` description clarifications

## [0.33.0] - 2026-08-09

### Added
- **RLM**: pass-by-reference sub-agent results (`ArtifactStore`)
- **RLM**: chunked parallel queries (`chunk_query` tool)
- **Config**: `subagent.resultMode`, `maxSummaryChars`, `artifactsDir`, `stableSystemPrompt`

## [0.32.0] - 2026-08-08

### Added
- **Browser**: driver abstraction (`PlaywrightDriver` + `BridgeDriver`)
- **Browser**: Node bridge for Bun compatibility
- **Config**: `browser.maxConsoleLineChars`

## [0.31.0] - 2026-08-08

### Added
- **Security**: session file encryption (AES-256-GCM)
- **Security**: audit notifications (file + webhook)
- **Security**: security policies (strict/balanced/permissive)
- **CLI**: `mma security` commands

## [0.30.0] - 2026-08-07

### Added
- **Execution**: final audit gate (runs `bun test` for verification steps)
- **Execution**: `detectTestResults()` auto-verification in bash

### Fixed
- **Execution**: empty-CLI entry-point hint
- **Bash**: Windows anti-patterns documentation

## [0.29.0] - 2026-08-07

### Added
- **Bash**: smart UTF-8/OEM line decoding (fixes Cyrillic on Windows)
- **Bash**: behavior-based background detection
- **Bash**: stuck-detector bash awareness

## [0.28.0] - 2026-08-06

### Fixed
- **Agent**: double-Esc interrupt fix (Bun readline keypress collapsing)
- **Agent**: abortable in-flight LLM requests on interrupt
- **UI**: clipboard paste hint

## [0.27.0] - 2026-08-06

### Fixed
- **Security**: Windows hardening
- **Hallucination**: fixes

## [0.26.0] - 2026-08-05

### Added
- **UI**: opencode-style inline tool headers (`ui.toolStyle`)
- **UI**: model commentary next to tool calls (`ui.toolComments`)
- **UI**: diffs without background color

## [0.25.0] - 2026-08-05

### Added
- **LSP**: LSP module (typescript, CSS, HTML, JSON, Python, Rust, Go)
- **Execution**: audit gate language-agnostic
- **Bash**: Windows command hints

## [0.24.0] - 2026-08-04

### Added
- **Context**: quality formula upgrade (token load + compaction loss + error density + freshness)
- **Read**: display mode (show only header in REPL, full content to LLM)

## [0.23.0] - 2026-08-04

### Added
- **Certification**: model certification module (`mma model certify`)
- **CLI**: cert checkmarks in model lists

## [0.22.0] - 2026-08-03

### Added
- **Security**: `enabled` flag (disabled by default)
- **CLI**: init/first-run apply wizard security answers
- **Prompt**: system prompt & recovery messages cleanup
