# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.35.3] - 2026-08-14

### Fixed
- **LSP dead for nested projects**: the workspace root is now resolved from the edited file's nearest project, using per-language markers declared in the LSP server config (`workspaceMarkers`). `typescript-language-server` could never find `typescript` when the project lived inside the agent baseDir, so every write/edit returned `[LSP check failed]: Could not find a valid TypeScript installation`.
- **Phantom "1 files missing" loop**: the final audit now requires files only from steps marked `done` and treats `skipped` as a terminal complete state. A skipped step's prose could previously poison the audit forever (a step referencing "type.ts" for the existing "types.ts" kept a finished task rejected).
- **Windows bash hints/block**: the win32 hint and hard-stop now key on the *original* command word. The `cat→type` translation previously hid `cat`/`ls`/`grep` failures from `UNIX_TO_WIN_HINTS`, so the model repeated them with no guidance.
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
