# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.43.0] - 2026-08-18

### Added

- **`plan delete <id>` and `plan purge`** (`src/modules/execution/plan-tool.ts` + `plan-store.ts`): `delete` permanently removes a plan by id (active plan → tracker cleared, missing id → error), `purge` wipes every plan (active/drafts/archived) plus the tracker and completed-plan state. Fixes the post-mortem session where the "очисти все планы" task burned 21 iterations because the plan tool had no way to delete anything.
- **`resolveTestCommand`** (`src/modules/execution/audit-runners.ts`): the final audit now runs the project's real test runner instead of always `bun test` — `package.json` `scripts.test` → vitest/jest/bunfig config files (detected independently of `package.json`) → `pyproject.toml`/`pytest.ini`/`conftest.py` → `go.mod` → `Cargo.toml` → `bun test` fallback. `findTestFile` also matches pytest files (`test_*.py`/`*_test.py`).

### Fixed

- **`plan abort` ignored `id`** — it always archived the active plan; now it archives the named plan (active or draft) and fails explicitly (`not found`/`already archived`/no active plan + no id) instead of returning `success:true` on an empty list.
- **`plan switch` to the already-active plan** duplicated it (two `active` entries, same id); it is now a no-op (`plan.already_active`).
- **Final audit skipped for a completed plan** — auto-archiving the last step cleared the tracker, so `runFinalAudit()` returned `null` and the agent declared success without checks. `ExecutionModule` now keeps `completedPlan` (set on both `plan update` completion and plugin auto-advance) and audits it when the tracker is null.
- **Plan nudge fired on bare iteration counters** (`src/modules/execution/execution-plugin.ts`): the `iter===3`/`iter>=6` injections (rule #10 violation) are replaced with an evidence-based nudge that fires once after ≥2 file-mutating tool calls without a plan.
- **`checkPlanAlignment` flagged phantom off-path warnings** — it JSON-stringified the whole args blob, so file tokens inside `content` (import strings, etc.) counted as off-path; it now scans only path-typed argument keys.
- **`isDepsStep` treated any "install" as a dependency step** — now it requires an actual package-manager verb (`npm install`, `bun add`, `pnpm dlx`, …).
- **Auto-advance couldn't see nested project files** — a step naming `src/App.tsx` with the real file at `baseDir/bicycle-shop/src/App.tsx` stayed pending; `findExistingFile` (bounded subtree walk) resolves it.
- **`replan` id collisions** — kept steps kept their original ids, so a done step id 3 collided with a new step id 3; ids are now renumbered sequentially. `toPromptBlock` shows "N/N done, complete" once every step is terminal.
- **File-less steps passed as verified** — `plan update ... done` on a step naming no files succeeds but notes `plan.no_deliverables` ("names no files").

## [Unreleased]

## [0.48.0] - 2026-08-21

### Added

- **Security enabled by default (balanced policy)** (`src/config/security.ts`): `security.enabled` and `security.bash.enabled` are now `true`, `blockDangerousFlags: true`, extended operator blacklist (`;`, `&&`, `||`, `|`, `` ` ``, `$(`), and an extended command blacklist (interpreters, Windows `del`/`rd`/`erase`/`taskkill`). The setup wizard no longer disables security when the user skips the security questions — answers only tighten the defaults. Master switch `security.enabled: false` still turns everything off.
- **Bash validator bypass closures** (`src/modules/security/command-validator.ts`): interpreter `-c/-e` invocations (bash/python/node/…), multi-line commands, and chaining to a blacklisted command (`echo hi; rm -rf /`) are blocked.
- **SSRF protection** (`src/modules/security/network-validator.ts` + tools): private/link-local IPs (127.0.0.1, 10.x, 192.168.x, 169.254.x, ::1, fc00::/7, fe80::) and non-http(s) schemes are blocked; `web_fetch` follows redirects manually with re-validation; `attach_image` validates URLs; browser `open` rejects `file:`/`chrome:`/`about:`/`data:` schemes.
- **MoE parallel cap** (`src/modules/execution/moe-executor.ts`): concurrent subtasks per wave are capped at `rateLimits.maxParallelTasks` (default 5).
- New i18n keys (en+ru): `exec.task_reminder`, `exec.stop_directive`, `exec.test_runner_fail/pass`, `exec.hint_*`, `plan.subtasks_done/no_subtasks/step_label`, `repl.ctrl_c_interrupt`, `setup.security_status_on`.

### Fixed

- **Path prefix escape** (`path-validator.ts`, `scope-check.ts`): containment now requires a path separator — a sibling directory sharing the prefix (`agent2` vs `agent`) is correctly rejected.
- **Secrets in logs**: session log (`logUser`/`logToolCall`/`logToolResult`) and app logger writes are sanitized through `sanitizeLogMessage`.
- **Encryption** (`encryption.ts`): key-persistence failure now throws instead of silently returning an unpersisted key; HMAC comparison uses `timingSafeEqual`.
- **Session file permissions**: session dirs 0700, files 0600.
- **Missing i18n key** `exec.task_reminder`; `/lsp` REPL command unbroken via typed `Agent.getModule()`; dead code removed (`reasoningAcc`, duplicate `updateProvider` call, `lastResult`, `getChainMaxAttempts`, `scopeRestored`).

### Performance

- Per-message token cache in `ContextManager` (eliminates O(n²) re-encoding on every iteration).
- Async `grep` with kill-on-timeout (no longer blocks the event loop).
- `read_file` streams files >1MB instead of loading them whole.

### Tests

- Integration suite excluded from default `bun test` (opt-in via `MMA_RUN_INTEGRATION=1`); tests isolated to temp dirs (no more touching real `~/.mma` or `/tmp` fixed paths); locale and `global.fetch` restored after tests.

## [0.43.0] - 2026-08-18

- **Folder plugins** (`src/modules/plugins/loader.ts`): `loadFromDir` now treats a subdirectory of the plugin dir as a plugin when it contains an entry file (`plugin.ts` → `plugin.js` → `index.ts` → `index.js`). The entry imports the folder's other modules via normal relative imports; folders without an entry are skipped. Flat `*.ts`/`*.js` files keep working unchanged. Tests in `tests/plugin-loader.test.ts`.
- **`trace-server` example split into a folder plugin** (`examples/plugins/trace-server/`): `plugin.ts` (entry) + `state.ts` (shared state + SSE primitives) + `util.ts` + `context.ts` (snapshots + conversation-text) + `plans.ts` (on-disk plan reading + poll) + `server.ts` (HTTP/SSE) + `page.html` (frontend, served **verbatim from disk** — never template-processed).

### Fixed

- **trace-server page script parse error** (`examples/plugins/trace-server/`): embedding the page in a template literal interpreted `\n` inside the page's JS strings as real newlines, so `e.text.split('\n')` became a broken string literal and the whole `<script>` failed to parse — the trace page connected but rendered nothing. The page is now read from disk verbatim, keeping escape sequences literal.
- **LSP servers dead in projects without a local `typescript`** (`src/modules/lsp/config.ts`): `typescript-language-server` (typescript/javascript) and the vscode html/css servers exited with `Could not find a valid TypeScript installation` on every write — `npx --package X` does not make `typescript` resolvable to the server process. The npx args now include `--package typescript@5` (pinned to TS 5.x: a bare `typescript` resolves to the native TS 7 preview whose `lib/` has no `tsserver.js`, so the server rejects it) and `--yes` (the old bare `npx typescript-language-server` prompted for confirmation on a cold cache). Verified: TS type error `Type 'string' is not assignable to type 'number'` is reported end-to-end through `checkFile`.
- **LSP banner false negatives under parallel probing** (`src/modules/lsp/probe.ts`): the REPL banner probed all applicable servers in parallel, so simultaneous npx auto-installs fought over the shared npx cache lock and half the servers reported `LSP request timeout: initialize` on a cold cache. Probing is now sequential, each server gets its own config timeout (capped), and an overall deadline bounds the banner. In `E:\projects\mma_tests` all 5 servers (typescript/javascript/json/html/css) now probe OK in ~10s.
- **LSP banner waited ~25s on stale configs** (`src/config/config.ts`): a `~/.mma/config.json` written before 0.41.1 overrides the fixed npx server args with the broken legacy ones (`npx typescript-language-server --stdio`, wrong `vscode-html-languageserver` names), so every probe hung until the initialize timeout (25s for 5 servers, html/css dead). `loadConfig` now normalizes stale `lsp.servers` args back to the current defaults when they match the known legacy form (custom arrays are left alone), mirroring the `restoreDangerousPatterns` precedent. Stale config now probes in ~5s with all servers up.
- **LSP probe time ~10s from strictly sequential waves** (`src/modules/lsp/probe.ts`): fully sequential probing is the safest on a cold npx cache but doubled the banner wait once the cache is warm. `probeLspServers` now probes in waves of `maxParallel` (default 3, `LspProbeDeps.maxParallel`) — fast on a warm cache, capped cold-cache contention, and each server in a wave uses its own `LspClient` (the client is stateful, so concurrent probes on a shared instance would cross-talk). MMA project: 10.2s → 5.2s, all 5 servers OK.
- **LSP process leak on Windows** (`src/modules/lsp/client.ts`): `shutdown()` killed only the direct `cmd.exe` wrapper, orphaning the `npx → node → tsserver` chain after every check (observed 2 leaked node processes per `checkFile`). It now uses the shared `killTree()` (`src/modules/processes/registry.ts`, now exported) — the same double `taskkill /T /F` used by the process registry — so the whole tree dies. Verified: leaked processes 3→0.

## [0.41.2] - 2026-08-18

### Fixed

- **REPL banner waited for the LSP probe** (`src/cli/repl.ts`): `Repl.start()` awaited `probeLspBanner()` _before_ printing the box, so the banner was blocked for the whole probe (~5s warm, ~25s cold/stale). The probe now runs in the background: the box prints immediately with a `LSP: …` placeholder as the last data row, and when the probe finishes the row is rewritten in place (`\x1b[2A\r\x1b[2K<row>\x1b[2B\r` — the LSP row is always two terminal rows above the prompt, stable under earlier-row wrapping). The rewrite is skipped when it would corrupt the screen (agent already running, non-TTY, narrow terminal, or summary too wide); `updateLspRow` normalizes whitespace like `box()`'s `wrapText` so the rewritten row is byte-identical to what `box()` would render. Non-TTY: no LSP row and no probe (no orphaned npx on piped exit). MMA project: banner at ~5.7s → ~2s.
- **Startup health check blocked the banner** (`src/core/bootstrap.ts`, `src/core/agent.ts`): bootstrap `await`ed `runStartupHealthCheck`, which runs `npx tsc --noEmit` over the whole project (observed 4.1s on MMA, returning null — a clean project), so every session start paid the full tsc cost before the banner. The check now starts in the background (a promise, never awaited at bootstrap) and is consumed via a new `AgentDeps.lazyPromptBlocks` supplier that `Agent.run()` awaits _before the first system prompt_ — the baseline block still reaches the first LLM call (guaranteed resolved by the time the user types in the interactive REPL) without delaying the banner. Skipped for `--exit-on-complete` and tests, as before. Tests in `tests/core/agent.test.ts` (lazy blocks awaited once, included in the first system prompt; empty result tolerated).

## [0.36.0] - 2026-08-15

### Added

- **`trace-server` example plugin** (`examples/plugins/trace-server.ts`): single-file, zero-dependency live agent-loop trace in the browser over SSE — phases, LLM calls, `tool_start`/`tool_end` with full args and results (paired client-side by `toolCallId`), errors, coalesced text/meta (350ms debounce), plus **context tracking**: a live context bar (tokens/budget, quality %, compaction count, iterations since compaction, message count) fed by `context` events, and `compaction` events rendered as CTX log entries (tokens/quality before and after). Binds localhost only; credential-shaped payload values are scrubbed.
- **`contextManager` exposed to all plugin hooks** (`src/core/agent.ts`): the plugin hook context now carries `contextManager` in `runOnPhase`, `runOnSessionStart`, `runOnError`, `runOnAfterThink`, `runOnToolStart`, `runOnToolEnd`, `runOnText`, `runOnMeta`, `runOnSessionEnd` (previously only in `runOnBeforeThink`). Enables plugins to observe live context state (budget, quality, compaction count).

### Changed

- The trace-server example plugin dedupes double-loading (global + project copies): a shared server lives on `Symbol.for("mma.trace-server")`, `startServer()` dedupes concurrent starts with an in-flight promise, and identical context snapshots are broadcast once.

## [0.35.3] - 2026-08-14

### Fixed

- **LSP dead for nested projects**: the workspace root is now resolved from the edited file's nearest project, using per-language markers declared in the LSP server config (`workspaceMarkers`). `typescript-language-server` could never find `typescript` when the project lived inside the agent baseDir, so every write/edit returned `[LSP check failed]: Could not find a valid TypeScript installation`.
- **Phantom "1 files missing" loop**: the final audit now requires files only from steps marked `done` and treats `skipped` as a terminal complete state. A skipped step's prose could previously poison the audit forever (a step referencing "type.ts" for the existing "types.ts" kept a finished task rejected).
- **Windows bash hints/block**: the win32 hint and hard-stop now key on the _original_ command word. The `cat→type` translation previously hid `cat`/`ls`/`grep` failures from `UNIX_TO_WIN_HINTS`, so the model repeated them with no guidance.
- **read_file blindness at near-full context**: tools that declare `boundedOutput` (`read_file`, `list_dir`, `file_info`, `process_log`) are never budget-truncated. A `read_file` output was being cut to ~2K chars when the context was near-full, making the model re-read the same file 8+ times.

## [0.27.0] - 2026-08-07

### Added

- **LLM-as-judge consistency check** (`src/modules/hallucination/consistency.ts`): the keyword-based
  contradiction heuristic is replaced with a judge-provider call when configured. Detects decision
  reversals (e.g. switching DBs mid-task) and degrades to `pass` when the judge provider is
  unavailable or errors.
- **Behavior-based background detection** (`src/tools/bash.ts`, `src/modules/processes/`): the
  `bash` tool no longer classifies long-running commands by text matching (heuristic in
  `src/modules/processes/detect.ts` removed). Any command still running after the 5s grace window
  is auto-promoted to the background and returns a process id. A command that mentions "vite"/"dev"
  now runs normally; a genuinely long-running command is always caught.

### Changed

- **Async process execution in verifier** (`src/modules/execution/verifier.ts`, `lint-on-write`
  plugin): blocking `execSync` replaced with async spawn so long syntax checks don't freeze the agent
  loop.
- **Spawn errors surfaced** (`src/tools/bash.ts`): a command that fails to spawn (bad `workdir`,
  missing shell) returns `[process error] ...` with `success: false` instead of a fake "Started"
  line with PID 0.
- **Process output encoding** (`src/modules/processes/registry.ts`): Windows output is decoded from
  the OEM code page (CP866) so Cyrillic is not garbled; log buffer raised to 2000 lines.
- **Process management API** (`src/modules/processes/`): `runCommand`/`isLongRunningCommand`
  removed; `processRegistry` gains `waitForExit()`/`remove()` and `spawnError`; `runner.ts` is now
  a kill-by-call-id registry (`registerKillable`/`unregisterKillable`/`killByCallId`).

### Fixed

- **Hallucination factual check false positives on Windows** (`src/modules/hallucination/factual.ts`):
  the path-extraction regex matched absolute Windows paths starting at the first word boundary after
  the drive letter, so `E:\project\src\a.ts` became `project\src\a.ts` and `resolve()` glued it onto
  `baseDir` — producing a bogus path and a false "unknown file" warning for files that actually exist.
  The regex now captures the drive letter and absolute paths resolve as-is. Well-known tech names
  (`Node.js`, `React.js`, `Next.js`, ...) are excluded from file-path detection so "used Node.js
  runtime" no longer flags a warning. Added `tests/hallucination-factual.test.ts` (6 cases).
- **Model tool/command confusion on Windows** (`src/tools/bash.ts`, `src/tools/executor.ts`): the
  agent would emit tool-call syntax inside `bash` (e.g. `create_dir path=...`) and use Unix commands
  that don't exist in `cmd.exe` (`ls`, `cat`, `head`). The system prompt now states the shell is
  `cmd.exe`; `adaptCommandForWindows` translates `ls→dir`, `cat→type`, `pwd→echo %cd%`, `wc→find`;
  `detectToolCallInBash` redirects tool-call-shaped bash input to the real tool via
  `ToolExecutor.executeByName()`.
- **Plan step tracking** (`src/modules/execution/tracker.ts`, `src/core/agent.ts`): plan updates no
  longer leave the tracker stuck on step 1, which caused false "No progress" / stuck warnings. The
  pointer is synced on plan update and step progress is logged to `session.jsonl` as `"plan"` events
  (`step-update`, `auto-advance`, `stuck-warning`).
- **Stuck detector reset on step change** (`src/modules/execution/stuck-detector.ts`): per-step
  iteration/error counters are reset when the current step changes, preventing false stuck warnings
  after legitimate progress.

## [0.26.0] - 2026-08-07

### Fixed

- **Dead hallucination pipeline wired up** (`src/core/agent.ts`, `src/modules/hallucination/`):
  the factual check (pre-existing paths cross-check) and MoE stuck detection were never invoked —
  both are now active. `HallucinationDetector` runs factual/confidence checks on every response and
  the MoE executor uses the detector for per-subtask stuck detection.

## [0.25.0] - 2026-08-06

### Added

- **LSP module** (`src/modules/lsp/`): language server diagnostics after every `write_file`/`edit_file`:
  - JSON-RPC 2.0 client over stdio with Content-Length framing (`client.ts`)
  - 7 languages: TS/JS (`typescript-language-server` via `npx`), Python (`pyright`), JSON (`vscode-json-languageserver`),
    HTML (`vscode-html-language-server`), CSS (`vscode-css-language-server`), Rust (`rust-analyzer`), Go (`gopls`)
  - Lazy server startup on first check; `autoInstall: false` — `npx` servers download on first use,
    `rust-analyzer`/`gopls` must be on PATH (`where` check with clear error)
  - `lsp-check` plugin (priority 15), severity 1 (errors) appended as `[LSP errors]` to tool output
  - Config via `config.lsp` (`DEFAULT_LSP_CONFIG` in `src/config/defaults.ts`), new module per design spec §6.13

### Fixed

- **Audit gate language-agnostic** (`src/modules/execution/auditor.ts`): removed hardcoded
  `tsc --noEmit` — auditor now only checks file existence from plan steps, works for any language
- **Windows command hints** (`src/core/bootstrap.ts`): added `head`/`tail` to the platform-specific
  command availability block so the model knows to use `Get-Content -TotalCount`/`Select-Object` on Windows

## [0.9.0] - 2026-08-01

### Added

- **Pipeline execution** (`src/tools/pipeline-run.ts`): `pipeline_run` now actually executes
  each step as an isolated sub-agent instead of only parsing/resolving the YAML DAG:
  - Parallel execution waves (up to 3 concurrent steps) honoring `depends_on`
  - Template rendering (`{param}` and `{{steps.<id>.output}}`) via `TemplateEngine`
  - Up to 3 retries with backoff per step, fail-fast on error
  - Recursion depth guard and audit logging on block

### Fixed

- **Content scanning**: `dangerousPatterns` RegExp objects were serialized to `{}` in
  `~/.mma/config.json` (`JSON.stringify(/eval\(/)` → `{}`), causing `String.match({})` to
  match any content and block all `write_file`/`edit_file` calls. Added `regexReplacer` /
  `regexReviver` round-trip in `src/config/config.ts` and `restoreDangerousPatterns()`
  fallback for corrupted configs.
- **Encryption**: `encryptSensitiveFields` / `decryptSensitiveFields` no longer destroy
  `RegExp` instances (previously converted them to `{}`).
- **Grep tool**: `grep` no longer runs its command through the bash security validator,
  which blocked regex patterns containing `|` as a shell pipe. Now uses `execFileSync('rg', args)`
  with array arguments (no shell interpretation) and falls back to `grep -r`.
- **Sub-agent tool**: when `tool_tags` matches no registered tools, the sub-agent returns a
  clear `[SECURITY BLOCKED]` error instead of silently spawning a tool-less sub-agent that
  hallucinates results.

## [0.8.0] - 2026-08-01

### Added

- **CLI security commands** (`src/cli/security-commands.ts`):
  - `mma security status` - Show current security configuration
  - `mma security policies` - List available security policies
  - `mma security set-policy <preset>` - Apply a security policy
  - `mma security enable-encryption` / `disable-encryption` - Toggle session file encryption
  - `mma security enable-audit` / `disable-audit` - Toggle audit notifications
  - `mma security audit-stats` - Show audit notification statistics
- **Translations** for CLI security commands in `en.json` and `ru.json`

### Fixed

- **Path validation**: Fixed arrays being converted to objects during config decryption in `encryptSensitiveFields` and `decryptSensitiveFields`
- **Audit notifications**: Fixed `globalAuditNotifier` not being updated with config from `loadConfig` - now updates in `bootstrap.ts`
- **Type consistency**: Fixed `AuditNotifierConfig` type mismatch between `config/types.ts` and `modules/security/audit-notifier.ts`
- **Security logging**: Added `logSecurityBlock` calls to `read-file.ts` for path validation blocks
- **Type additions**: Added `file_read` to `AuditEventType` and `logSecurityBlock` action types
- **Network validation**: Added `localhost`, `127.0.0.1`, `::1` to default `deniedDomains` for testing
- Fixed `ConfidenceCheck` test for short response validation
- Fixed `OpenAICompatProvider` tests by adding proper mock `json()` and `text()` methods
- Fixed retry count expectations in tests to match actual retry logic (`maxRetries + 1`)

## [0.7.10] - 2026-08-01

### Added

- **Session file encryption** (`src/modules/security/session-encryption.ts`):
  - Encrypt `history.jsonl` and `session.jsonl` files with AES-256-GCM
  - Configurable via `security.sessionEncryption` in config
  - Backward compatible - can read old unencrypted files
  - Custom key path support

- **Audit notifications** (`src/modules/security/audit-notifier.ts`):
  - File-based audit notifications to `~/.mma/logs/audit-notifications.jsonl`
  - Webhook support for real-time notifications
  - Configurable severity levels and event types
  - Automatic retry for failed webhook deliveries
  - Statistics and analytics for audit events

- **Security policies** (`src/modules/security/security-policies.ts`):
  - Three preset policies: `strict`, `balanced`, `permissive`
  - Easy switching between policies via `applySecurityPolicy()`
  - Custom policy support with overrides
  - Use case recommendations (production, development, testing)
  - Policy comparison functionality

- **SessionStore encryption integration**:
  - Automatic encryption of session files when enabled
  - Transparent read/write operations

### Changed

- Updated `SecurityConfig` type to include `sessionEncryption` and `auditNotifier`
- Updated default security config in `src/config/security.ts`
- Updated `SessionStore` to support encryption configuration
- Updated `SessionManager` to pass encryption config to store

### Security

- Session files can now be encrypted at rest
- Audit trail with optional notifications
- Predefined security policies for different environments

## [0.7.9] - 2026-07-31

### Added

- **Session isolation** (`src/modules/security/session-isolation.ts`):
  - Per-session security configuration overrides
  - Isolated plugin loading per session
  - Separate temporary directories for each session
  - Session context management

- **SessionManager updates**:
  - Support for `securityOverrides` in session metadata
  - Session context creation and management
  - Isolation configuration options

### Changed

- Updated `SessionMeta` type to include `securityOverrides`
- Updated session-related types in `src/modules/session/types.ts`

## [0.7.8] - 2026-07-30

### Added

- **File operations counter** in `ToolContext`:
  - Track number of file operations per session
  - Configurable limit via `security.maxFileOperations`
  - Applied to all filesystem tools

- **LLM rate limiting** (`src/modules/security/rate-limiter.ts`):
  - Request rate limiting (60/minute default)
  - Parallel task limiting (5 default)
  - Configurable via `security.rateLimits`

- **Config encryption** (`src/modules/security/encryption.ts`):
  - AES-256-GCM encryption for sensitive config fields
  - Automatic encryption/decryption of `api_key`, `token`, `password`
  - Key management with `~/.mma/.encryption-key`

- **Logger sanitization**:
  - Automatic removal of sensitive data from logs
  - Integration with existing logger

### Changed

- Updated `ConfigEncryptor` to handle nested objects
- Updated `AppConfig` type to support encrypted fields
- Updated config loading to decrypt sensitive fields

## [0.7.7] - 2026-07-29

### Added

- **Bash command validation** (`src/modules/security/command-validator.ts`):
  - Blacklist of dangerous commands (rm, dd, chmod, etc.)
  - Whitelist mode (optional strict)
  - Blocking of dangerous flags (--force, -rf, etc.)
  - Blocking of dangerous operators (|, >, >>, ;, &&)
  - Command logging to audit log

- **Path validation** (`src/modules/security/path-validator.ts`):
  - Global denied paths (.git/, node_modules/, .env, etc.)
  - Global allowed paths (optional whitelist mode)
  - Integration with existing ToolScope

- **Network validation** (`src/modules/security/network-validator.ts`):
  - Denied domains blacklist
  - Allowed domains whitelist (optional)
  - URL sanitization

- **Content scanning** (`src/modules/security/content-scanner.ts`):
  - Detection of dangerous patterns in file content
  - Applied to write_file and edit_file

- **Subagent recursion control** (`src/tools/subagent.ts`):
  - Maximum recursion depth limit (default: 3)

- **Audit logging** (`src/modules/security/audit-log.ts`):
  - Logging to `~/.mma/logs/audit.jsonl`
  - Events: tool calls, file operations, bash commands, network requests, security blocks

- **Data sanitization** (`src/modules/security/data-sanitizer.ts`):
  - Automatic removal of API keys, tokens, passwords from logs

### Changed

- Updated all filesystem tools to use path validation
- Updated bash tool to use command validation
- Updated web tools to use network validation
- Updated subagent tool to respect recursion limit

## [0.7.6] - 2026-07-28

### Added

- Initial security module structure
- Security configuration types
- Basic security checks integration

## [0.7.0] - 2026-07-20

### Added

- Initial MMA v2 release
- Agent state machine
- Tool system with 20+ tools
- Module system (skills, plugins, mcp, etc.)
- CLI and REPL interfaces
