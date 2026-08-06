# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
