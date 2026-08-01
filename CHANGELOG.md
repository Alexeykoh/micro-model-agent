# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
