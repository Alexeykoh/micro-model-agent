# Full config surfaces — design (2026-09-27)

## Decision
- New registry value types: `json` (records/objects, validated by per-key `parse`+`stringify`) and
  `list` (string arrays, comma-separated in REPL, JSON array in REST).
- Scalar/enum/bool/int/share keys: full parity terminal ↔ web via existing
  `setConfigValue` path. No new REST endpoints.
- Complex keys (lists/records/servers): registry `json`/`list` defs + guided editors
  (textarea with validation + error line), NOT per-field key explosion.
- MCP: add `POST /api/mcp` (create) + `PUT /api/mcp/:id` (full edit); toggle stays.
  Create/edit takes effect on next run (`restartRequired: true`, like toggle).
- LSP: web is read-only table + single-server JSON edit (`PUT /api/lsp/:lang`);
  full add/remove stays JSON-only (server binaries are host-specific).
- Providers form: add `maxCompletionTokens`, `cache.*` (mechanism/report selects +
  6 bool flags), `retry.maxRetries/baseDelay/maxDelay`. No new endpoint.
- No new top-level REPL commands except `/security status` (read-only summary);
  everything else via `/config` + existing sugar. Rule #17: extend maps only.
