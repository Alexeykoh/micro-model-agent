# Web UI command journal (`session.jsonl`)

_Status: implemented 2026-10-29 (B-35 / B-37, stress register)._

## Problem

Slash commands typed in `mma web` were visible only in the live SSE feed. `/export`
runs server-side but left no record; `/clear` and `/new` are browser-only, so the
server never saw them at all. Replaying a session could not answer "what command
did the user run, and what was the result?".

## Contract

### 1. New session log type `command`

`SessionLogEntry.type` gains the closed-union member `"command"` (no new event
system, no template literals). One record per command invocation:

| field | value |
|---|---|
| `source` | `module:webui` |
| `module` | `webui` |
| `content` | command line, redacted (`redactContextSecrets`), capped at 600 chars |
| `status` | `ok` \| `error` |
| `success` | boolean |
| `message` | short result (lines the user saw, redacted, capped) |

Failure detection follows the existing command convention: a result line starting
with `↳` (or an exception) marks the command as `error`.

`GET /api/sessions/:id/log` whitelists the new type; Trace may request it.

### 2. `POST /api/command` accepts `{ action }`

The endpoint keeps `{ line, sessionId? }` for real commands. A dedicated
client-only form is added:

```json
{ "action": "clear" | "new", "sessionId": "ses_…" }
```

The server **does not execute** the action. It appends a `command` record
(`/clear` / `/new`, success, `client-side`) to the session named by `sessionId`
(even when another session is active or busy), then answers `202 {ok:true}`.
Unknown actions answer `400 {error:"unknown_action"}`. The web composer uses this
after performing the local clear/new operation.

## Non-goals

- No server-side feed clear or session switch.
- No transcript replay of command output: the journal stores a short result only.
- No new secrets path: entries go through the existing `redactContextSecrets`.

## Guards

- `tests/webui-command-log.test.ts`: API appends the record, client-only action is
  journaled without server execution, the client helper posts the action.
- `tests/webui-mcp-form-dom.test.ts`: inline error inside the form, no header toast
  on validation, field visibility by transport, empty transport rejected (B-37).
