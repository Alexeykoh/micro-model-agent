# Tools & UI Components

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

| Field      | Required | Description                                                       |
| ---------- | -------- | ----------------------------------------------------------------- |
| `question` | yes      | Complete question text                                            |
| `header`   | no       | Short label (max 30 chars) shown above the question               |
| `options`  | no       | Array of `{label, description}` choices; omit for free-text       |
| `multiple` | no       | Allow selecting more than one option                              |
| `custom`   | no       | Allow typing a custom answer (default: true when options present) |

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
};
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

## Browser Tool

Playwright-based headless browser for web navigation, form filling, and page interaction.

### Actions

| Action       | Parameters                       | Description                                  |
| ------------ | -------------------------------- | -------------------------------------------- |
| `open`       | `url`                            | Navigate to URL, returns element snapshot    |
| `click`      | `target` (number)                | Click element by snapshot index              |
| `type`       | `target`, `text`                 | Type text into element                       |
| `scroll`     | `direction` (up/down/top/bottom) | Scroll page                                  |
| `back`       | —                                | Go back in history                           |
| `forward`    | —                                | Go forward in history                        |
| `screenshot` | —                                | Capture page screenshot (vision models only) |
| `snapshot`   | —                                | Re-read current page elements                |
| `wait`       | `ms`                             | Wait for page changes                        |
| `close`      | —                                | Close browser session                        |

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

**Browser binary resolution (offline / locked-down machines).** Playwright pins an exact Chromium revision; if it was never downloaded (blocked CDN, no network) `chromium.launch()` fails with `Executable doesn't exist at …`. Both transports then fall back to an installed system browser:

- **Env overrides** (`resolveBrowserLaunchOverrides`, `driver.ts`): `MMA_BROWSER_EXECUTABLE=<abs path>` (e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`) or `MMA_BROWSER_CHANNEL=chrome|msedge|chromium`. An explicit override is honored as-is and suppresses the automatic fallback.
- **Automatic fallback** (`launchChromiumWithFallback`, mirrored in `bridge-server.mjs`): only when the bundled revision is missing, retry with `channel: "chrome"`, then `channel: "msedge"`. Unrelated launch errors are rethrown without fallback.

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

## Tool Set Narrowing (on-demand enable)

> **Status:** implemented (v0.40.0). The main agent loop exposes only a small default tool set instead of all ~28 — fewer schema tokens in every LLM call (~2100 vs ~3500).

- **Config `tools`** (`src/config/types.ts` `ToolsConfig`): `defaultTags` (default `["file","code"]`) + `enableOnDemand` (default `true`).
- **`alwaysOn` flag** on `ToolDefinition` (`src/tools/types.ts`) — tools that survive any tag filter; `getAllForLLM()`/`getByTags()`/`filterToolsByTags()` all keep them. Structural tools `plan`/`todo`/`verify`/`project_map`/`lsp_check`/`session_info` are `alwaysOn`, so plan enforcement, LSP checks and session self-inspection survive narrowing.
- **`enable_tools` tool** (`src/tools/enable-tools.ts`, `alwaysOn`) — the model pushes tags (e.g. `["research"]`) into the shared mutable `activeToolTags` array; the agent loop recomputes the LLM tool set **every iteration** (`agent.ts`), so enabled tools appear next turn.
- **Hidden-tools prompt block** (`src/tools/hidden-tools-block.ts`, wired via `getDynamicPromptBlocks` in `bootstrap.ts`) — lists tag-grouped hidden tools so the model knows they exist and can call `enable_tools` or route via `subagent tool_tags`.
- **Default set (18):** file tools, bash (code), subagent, chunk_query, download_file, mcp_call, pipeline_run + alwaysOn (plan/todo/verify/project_map/lsp_check/session_info/enable_tools). **Hidden (11):** web_search/web_fetch/web_browse (research), browser, attach_image, process_list/process_log/process_kill, remember/recall, search_history.

## Session Self-Inspection

The model can answer questions about the session it is running in without shelling out:

- **`session_info` tool** (`src/tools/session-info.ts`, `alwaysOn`) — returns id, name, model, provider, context window, message count, created/updated timestamps, plus **live context usage** (`tokens / history budget (percent)`) from `ContextManager.getSnapshot()`. Reads live metadata through a `sessionManager` getter on `ToolContext` (wired in `bootstrap.ts`, like `sessionId`/`sessionContext`), so a REPL `/new` or `/resume` is reflected immediately. Added because the model otherwise reported having "no access to session metadata".
- **System-prompt block** (`SessionModule.getSystemPromptBlock`, collected via `getDynamicPromptBlocks` in `bootstrap.ts`) — a compact `[Session: "name" (id) | model: … | context: … tokens]` line. Deliberately carries **stable per-session fields only** (no message count) so the system prompt does not mutate every turn and the prefix KV-cache survives (rule #10). Live values are served by the `session_info` tool. It is collected dynamically, not at bootstrap: the session is created during bootstrap with `messageCount === 0`, so a static collect always yielded `null` (the previous silent bug).
- `enableOnDemand: false` restores legacy all-tools behavior (no `enable_tools` registered, empty tags → `getAllForLLM` returns everything).
- Subagent guard (`src/tools/subagent.ts`) uses `getByTags` for unknown-tag detection (alwaysOn tools otherwise masked it).

## Process Management

Long-running commands (dev servers, watchers) no longer block the agent.

### Bash behavior

- The `bash` tool uses **async spawn** (non-blocking event loop); the old `execSync` blocking behavior is gone.
- Any command still running after the grace window (5s, `BASH_GRACE_MS` in `src/tools/bash.ts`) is **auto-promoted to the background** — it returns a process id and partial output instead of hanging. Detection is behavioral (process still alive), never text matching, so a command mentioning "vite"/"dev" runs normally while a genuinely long-running command is always caught.
- Force background immediately with `background: true` (short settle window to surface spawn failures), force foreground with `background: false`.
- A command that fails to spawn (bad `workdir`, missing shell) returns `[process error] ...` with `success: false` instead of a fake "Started" line.
- Foreground commands are killed on the executor timeout (60s) via kill-by-call-id (`registerKillable` in `src/modules/processes/runner.ts`).

### Management tools

| Tool           | Purpose                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `process_list` | List background processes: id, PID, command, status, last output line                                               |
| `process_log`  | Show buffered output of a background process (`id`, optional `tail`)                                                |
| `process_kill` | Kill a background process tree (`id`) — works even though `kill`/`pkill` are blocked by the bash security blacklist |

- PIDs are tracked in `src/modules/processes/registry.ts` (per-session, capped at 20 entries, 2000 log lines each). Windows output is decoded from the OEM code page (CP866) so Cyrillic is not garbled. Output buffers are capped.
- Windows: processes are killed with `taskkill /pid <pid> /T /F`; POSIX: process-group kill (`detached` spawn).
- `Agent.shutdown()` kills all remaining background processes (no orphans).
