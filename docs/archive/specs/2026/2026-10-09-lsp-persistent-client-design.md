# LSP client redesign: persistent servers, spec compliance, tests

Date: 2026-10-09
Status: implemented (branch `fix/lsp-persistent-client`, release 2.39.0)

## Problem

An audit of `src/modules/lsp/` (client, module, check-tool, startup-check, probe)
against LSP 3.17/3.18 and against how agent-facing LSP clients are built in 2026
(see `agent-lsp`, an MCP wrapper whose selling point is *"Maintains a persistent
session: the language server index stays warm across all tool calls"*) found that
MMA uses a language server **as a one-shot CLI linter**.

### 1. Every check spawns and kills a server process

`LspModule.getPlugin().onAfterTool` (`src/modules/lsp/module.ts:206`) →
`LspClient.checkFile` (`src/modules/lsp/client.ts:79`) → `initialize()`
(`client.ts:156`) → `startServer()` (`client.ts:219`) → server spawned →
`didOpen` → **first** `publishDiagnostics` → `shutdown` + `killTree`
(`client.ts:412`).

Consequences per session start, before the model sees the first prompt:

- `probeLspServers` (`src/cli/repl.ts:1461`) spawns a server per applicable language.
- `runStartupHealthCheck` (`src/modules/lsp/startup-check.ts:99`) spawns one per file, up to 5.

Then per write: one more. `lsp_check` on a directory: one per file, up to 15.
Ten edits to a `.ts` file = ten `npx.cmd → node → typescript-language-server →
tsserver` chains. There is no `didChange`, no document state, no `didClose` —
the process is destroyed instead of asked to close. The 3.17 spec states client
support for `didOpen`/`didChange`/`didClose` is **mandatory** and a server must
implement all three or none.

This is the expensive part: a language server's value is a warm index, and it is
thrown away on every keystroke.

### 2. Spec violations (silent wrong answers, not just slowness)

| # | Where | Violation |
|---|-------|-----------|
| a | `types.ts:8`, filters `module.ts:213,338` | `severity` typed as required; spec makes it **optional**, absent = `Error`. Such diagnostics are dropped silently. `clangd` emits `severity: 0`. |
| b | `client.ts:428`, `uriToPath` `symbols.ts:57` | `pathToUri` does not encode; `uriToPath` does `decodeURIComponent`. Paths with spaces, `#`, `%`, non-ASCII produce invalid/asymmetric URIs. |
| c | `client.ts:284` | Only `\r\n\r\n` accepted as header separator; an LF-only server stalls to timeout. |
| d | `client.ts:338` | Server→client requests (`workspace/configuration`, `client/registerCapability`, `window/workDoneProgress/create`) are dropped with no response; the server can hang. Works only because the client never advertises those capabilities. |
| e | `client.ts:168` | Capabilities omit `general.positionEncodings` (3.17 negotiated offset encoding), `clientInfo`, `publishDiagnostics.versionSupport`, `textDocument.diagnostic` (pull diagnostics). |
| f | `client.ts:402` | No `didClose` before shutdown — state leaks inside the server (and inside a future long-lived one). |
| g | `check-tool.ts`/`client.ts` | Timeout resolves with `[]` (`client.ts:99`), indistinguishable from "clean" — the model concludes "no errors". |

### 3. A leaked timer

`startServer` (`client.ts:266`) installs a start-timeout `setTimeout` that is
**never cleared**. `lsp_check` over 15 files leaves 15 pending timers of up to
30 s each, all holding `this` (the client, its buffer, the diagnostics map).

### 4. No tests on the transport

`client.ts` — 457 lines, the entire JSON-RPC framing, correlation, timeout and
diagnostics-replace logic — has **zero** test coverage. Only
`resolve`/`symbols`/`probe`/`startup-check`/`diagnose` are tested. Every defect
above lives in the untested part.

### 5. The TypeScript default is the slow path

`typescript`/`javascript` servers run `npx typescript-language-server` +
`tsserver` (Node, hundreds of MB, 1–2 GB on large repos — see
typescript-language-server#472). In 2026 there is `tsgo`
(`@typescript/native-preview`), the native Go port of TypeScript, which is also
a language server (`tsgo --lsp --stdio`), ~10 faster to check and ~8 faster to
load a project, with much lower memory. For a harness whose stated target is
weak local hardware with small models, this is the better default and it is not
configurable today.

## Goals

- One server per `(server, projectRoot)`, kept warm for the session; documents
  synced with `didOpen`/`didChange`/`didClose`; servers reaped on idle, shut down
  on session end.
- Diagnostics answers are correct per spec: `severity` optional, URIs symmetric
  and encoded, timeouts distinguishable from "clean", server→client requests
  answered, CRLF and LF framing both accepted.
- The JSON-RPC transport is unit-tested against a fake server process.
- `tsgo` available as a first-class TS/JS server choice.
- Existing behaviour of `onAfterTool`, `lsp_check`, startup check, `/lsp doctor`,
  REPL/LSP status and the web LSP tab is preserved (messages, thresholds,
  failure-disable logic).

## Non-goals

- **No new LSP features** (hover, definition, references, code actions). The
  harness asks a compiler for errors; a wider surface costs context budget and
  adds risk for no user-visible gain.
- **No pull-diagnostics rewrite.** `textDocument/diagnostic` is advertised so a
  server may prefer it, and the client issues it when the server advertises
  `diagnosticProvider`; push (`publishDiagnostics`) remains the primary path
  because it is universally supported and already wired.
- **No daemon broker across processes.** A cross-session broker is a separate
  process with its own lifecycle; that is out of scope here. Session-scoped warmth
  is the win (an edit session is one process anyway).
- **No new config domain.** Only additive keys under the existing `lsp.*`.
- **No replacement of the startup `tsc --noEmit` path** when `tsconfig.json` is
  present — it is fast and correct, and the persistent server makes the
  fallback path cheap, not free.

## Design

### 1. Transport split: one connection per server process

`src/modules/lsp/connection.ts` — `LspConnection` owns exactly one server
process: spawn, framing, request/response correlation, per-URI diagnostics
registry, `shutdown`/`exit`/kill.

```
interface ServerProcess {                     // satisfied by ChildProcess
  stdin: Writable | null;
  stdout: Readable | null;
  kill(signal?: number | string): boolean;
  once(event: "exit", cb: (code: number | null) => void): void;
  on(event: "error", cb: (e: Error) => void): void;
}
```

The spawn factory is injectable, so tests drive the connection with an in-memory
fake server — real framing, real correlation, real timeouts, no child processes.

Responsibilities:

- `open(config, projectRoot)` → spawn + `initialize` (with `clientInfo`,
  `general.positionEncodings`, `textDocument.publishDiagnostics`,
  `textDocument.diagnostic`, `workspace.symbol`) + `initialized`.
- `sync(uri, languageId, text)` → `didOpen` if new or text changed, else
  `didChange` with `TextDocumentSyncKind.Full`. Version counter per document.
- `close(uri)` → `didClose`.
- `diagnostics(uri)` → current list, or `null` when the file is not open.
- `requestDiagnostics(uri)` → `textDocument/diagnostic` when the server
  advertised `diagnosticProvider`; otherwise wait for push with a deadline.
- `request(method, params)` → correlated JSON-RPC request with timeout.
- `shutdown()` → `shutdown` → `exit` → short grace → `killTree`.

Answering server→client requests: any `msg.id` + `msg.method` is answered with
`{"jsonrpc":"2.0","id":…,"result":null}` unless it is a known request we handle
(`window/workDoneProgress/create` returns `null`, which the spec defines as
"operation not supported"). Unknown ones get an error result with
`MethodNotFound`. Without this the server's promise never settles.

Framing (`src/modules/lsp/framing.ts`, pure):

- `findHeaderEnd(buf)` → index of the blank line, accepting `\r\n\r\n` **and**
  `\n\n` (and the mixed `\r\n\n` a few servers emit).
- `parseContentLength(headers)` → byte length, tolerant of case and extra
  whitespace; rejects non-numeric.
- `MAX_FRAME_BYTES` stays 10 MB, but the length is now read from a parsed header
  object rather than a regex over a decoded slice.
- Buffering keeps raw bytes until a whole frame is present (`Content-Length`
  counts bytes, not JS chars).

Diagnostics replace semantics per spec: a `publishDiagnostics` **replaces** the
list for that URI, including an empty list meaning "clean". The registry is
`Map<uri, DiagnosticRecord>` where the record carries the document version it
belongs to, so a stale push for an older version is ignored (the spec's
"avoid applying outdated results" guidance).

### 2. Pool: `LspConnectionPool`

`src/modules/lsp/pool.ts` — owns connections keyed `serverKey + "\u0000" +
projectRoot`:

- `acquire(server, projectRoot)` → live connection, creating it if needed
  (single-flight per key; the same promise is returned to concurrent callers).
- LRU with `LSP_MAX_SERVERS` (3, `src/config/timeouts.ts`): the least-recently-used
  connection is shut down when the cap is hit.
- Idle reaping `LSP_SERVER_IDLE_MS` (300 s, sweep `LSP_IDLE_SWEEP_MS` 15 s): a
  connection unused for longer than the TTL is closed. On a harness that lives for
  a whole session, an idle cap prevents a forgotten server from surviving it.
- Exit handling: if a server process dies on its own (`exit` event), the
  connection is dropped from the pool so the next `acquire` restarts it — no
  permanent "zombie" entry.
- `dispose()` → shutdown everything, clear the sweep timer.

### 3. `LspClient` becomes a facade

`client.ts` keeps its public surface (`checkFile`, `probe`, `workspaceSymbol`,
`setLogger`, `setOffline`) so `module.ts`, `startup-check.ts`, `diagnose.ts` and
the injected test doubles keep working unchanged; internally it owns a pool.

`checkFile` becomes: acquire → `sync` → `requestDiagnostics` → map to
`LspDiagnostic[]`. No spawn on the hot path: the process and the index are reused.

Result typing distinguishes the two outcomes:

```ts
export interface CheckResult {
  diagnostics: LspDiagnostic[];
  /** true when the answer is a timeout, not the server's verdict (i.e. not "clean"). */
  inconclusive: boolean;
}
```

`checkFile` returns `CheckResult`; callers that render text annotate an
`inconclusive` result instead of printing "no errors" (fixes defect 2 g).

Fail-freezing for a dead server stays as-is: `MAX_CONSECUTIVE_LSP_FAILURES`
(3) and the disabled-server set in `module.ts` are untouched.

### 4. Spec-compliance fixes (independent of the pool)

- `LspDiagnostic.severity` becomes `severity?: number`; a single helper
  `isErrorDiagnostic(d)` treats `undefined`/`0` as error. Both filters in
  `module.ts` use it.
- `src/modules/lsp/uri.ts` — one implementation of `pathToUri`/`uriToPath`:
  encode with `encodeURIComponent` on path segments (leaving `/` and `:`),
  decode symmetrically. `symbols.ts` imports it; the local copy is deleted.
- Timeouts: `startServer`'s timer is stored and cleared; `LSP_SERVER_IDLE_MS`
  and `LSP_MAX_SERVERS` land in `src/config/timeouts.ts` and the registry.
- `languageId` maps unify in `src/modules/lsp/language.ts` (today they are
  duplicated in `config.ts` and `client.ts` and disagree on `scss`).

### 5. `tsgo` as a first-class TypeScript server

A new `typescript-native` server entry in `DEFAULT_LSP_CONFIG`:

```ts
typescriptNative: {
  command: "tsgo",
  args: ["--lsp", "--stdio"],
  autoInstall: false,
  workspaceMarkers: ["package.json", "tsconfig.json"],
}
```

and `lsp.typescriptEngine: "tsgo" | "typescript-language-server"`
(default `typescript-language-server`, i.e. unchanged behaviour). When `tsgo` is
selected, `typescript`/`javascript` resolve to it. The LSP doctor shows which
engine is active and installs the hint (`npm i -D @typescript/native-preview`).

This keeps the current default working and makes the fast path one config line.

### 6. Lifecycle and shutdown

The LSP plugin adds `onSessionEnd` → `pool.dispose()`, so a session's servers die
with it (today they die after every check, which is the other extreme). Web
per-session runners get the same via `onUnload`/dispose paths already present for
other stateful plugins.

### 7. UI surfaces

`/lsp status` grows two lines: live server count (warm connections) and
reaped/restart counts. Nothing else changes; `/lsp doctor` keeps its classes and
adds the engine line. No new i18n domains beyond `lsp.*`.

## Files

| File | Change |
|------|--------|
| `src/modules/lsp/framing.ts` | new — pure header/frame helpers |
| `src/modules/lsp/uri.ts` | new — symmetric file↔URI |
| `src/modules/lsp/language.ts` | new — one languageId table |
| `src/modules/lsp/connection.ts` | new — one server process, JSON-RPC, diagnostics |
| `src/modules/lsp/pool.ts` | new — warm connections, LRU, idle reap, dispose |
| `src/modules/lsp/client.ts` | rewritten as pool facade |
| `src/modules/lsp/module.ts` | `CheckResult`, `isErrorDiagnostic`, `close()` |
| `src/modules/lsp/types.ts` | `severity?`, `CheckResult` |
| `src/modules/lsp/config.ts` | `typescriptNative`, engine resolution |
| `src/modules/lsp/symbols.ts` | imports `uri.ts` |
| `src/modules/lsp/check-tool.ts` | inconclusive plumbing |
| `src/modules/lsp/diagnose.ts` | engine line |
| `src/modules/lsp/index.ts` | new exports |
| `src/config/timeouts.ts` | `LSP_SERVER_IDLE_MS`, `LSP_IDLE_SWEEP_MS`, `LSP_MAX_SERVERS`; registry: `lsp.typescriptEngine` |
| `tests/modules/lsp/{framing,uri,language,connection,pool}.test.ts` | new |

## Phases

1. **Pure helpers** (`framing`, `uri`, `language`) + tests. No behaviour change.
2. **Transport** (`connection`) + tests against a fake server process.
3. **Pool** + tests (LRU, idle reap, restart after external exit, dispose).
4. **Facade** (`client` → pool) + `module` spec fixes + `CheckResult`.
5. **`tsgo` engine** + config/registry/doctor.
6. **Docs**: AGENTS.md, CHANGELOG.md, this spec.

Each phase keeps `bun test` + `tsc --noEmit` + `bun run quality` green.

## Risks

- **Long-lived servers keep memory.** Mitigated by LRU cap + idle reaping; a
  tsserver per session is the same footprint VS Code carries.
- **Stale diagnostics** after a failed `didChange`. Mitigated by per-document
  version tracking; a push with an older version is dropped.
- **Restart storms** if a server exits immediately. The pool drops the entry on
  exit; `module.ts`'s existing 3-failure disable stops repeated probes.
- **Windows spawn path unchanged** (`.cmd` via `cmd.exe`) — the same
  `resolveSpawnCommand`/`buildWinCommandLine` pair, only now reused.

## Verification

- Unit: framing (CRLF/LF/mixed, oversized, split frames), URI round-trip
  (Windows/posix/unicode/spaces), connection (correlation, timeout, diagnostics
  replace per URI, stale-version drop, server→client request answers,
  shutdown ordering), pool (LRU, idle reap, restart, dispose).
- Behaviour: `lsp_check` on the repo itself reports the same set before/after
  (spot-check a file with a known error).
- Manual: after five successive edits to one file, exactly **one** server
  process is alive (before: five spawned, zero alive).
- `bun test`, `tsc --noEmit`, `bun run quality`.
