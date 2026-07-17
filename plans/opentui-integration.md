# OpenTUI Integration Plan — MMA

## 1. Architecture Overview

### Core Problem
`loop.ts` and `repl.ts` hardcode output via `process.stdout.write()` and `console.log()`. OpenTUI owns the terminal in split-footer mode and provides its own output surface. We need a **Renderer abstraction** that both backends implement.

### Component Tree (OpenTUI mode)

```
Terminal (split-footer, footerRows=3)
├── ScrollbackSurface (top — conversation output)
│   ├── Markdown (streaming LLM responses)
│   ├── Text (tool call headers, errors, system messages)
│   └── Code / Diff (file diffs when available)
├── Footer (bottom 3 rows)
│   ├── StatusBar (row 1: provider/model | tokens | step)
│   └── Input (row 2-3: multiline input with history)
```

---

## 2. New Files

### `src/tui/types.ts` — Renderer Interface

```ts
export interface Renderer {
  // Output
  write(text: string): void           // raw text to scrollback
  writeLine(text: string): void       // text + newline
  writeError(text: string): void      // styled error
  writeWarning(text: string): void
  writeInfo(text: string): void
  writeSuccess(text: string): void
  writeToolHeader(name: string): void
  writeToolResult(time: string, exitCode?: number): void
  writeMarkdown(chunk: string): void  // streaming markdown token
  commitMarkdown(): void              // finalize current markdown block
  clear(): void                       // clear scrollback

  // Status
  updateStatus(info: StatusInfo): void

  // Lifecycle
  start(): Promise<void>
  stop(): void

  // Events
  onInput(handler: (input: string) => void): void
  onKey?(handler: (key: KeyEvent) => void): void

  // Access
  readonly mode: 'readline' | 'tui'
}

export interface StatusInfo {
  provider?: string
  model?: string
  tokens?: number
  contextWindow?: number
  step?: number
  maxSteps?: number
}

export interface KeyEvent {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
}
```

### `src/tui/readline-renderer.ts` — Current Behavior Wrapped

Wraps existing `console.log()` / `process.stdout.write()` behind the `Renderer` interface. This is a thin shim — zero behavior change for `mma` without `--tui`.

Key implementation notes:
- `write()` → `process.stdout.write(text)`
- `writeLine()` → `console.log(text)` (or `process.stdout.write(text + '\n')`)
- `writeMarkdown()` → `process.stdout.write(chunk)` (same as current `doChat` streaming)
- `commitMarkdown()` → `console.log()` (newline after streamed block)
- `writeToolHeader()` → `console.log(theme.toolHeader(name))`
- `writeToolResult()` → `console.log(theme.timingLine(time, exitCode))`
- `updateStatus()` → noop (no status bar in readline mode)
- `onInput()` → uses `readline/promises` internally
- `start()` / `stop()` → no-ops (readline lifecycle handled by caller)

### `src/tui/opentui-renderer.ts` — OpenTUI Renderer

Uses OpenTUI components:

```ts
import { Terminal, Box, Text, Input, Textarea, ScrollBox, Markdown } from 'opentui'

export class OpenTuiRenderer implements Renderer {
  private terminal: Terminal
  private scrollback: ScrollBox
  private markdown: Markdown | null = null
  private statusBar: Box
  private input: Textarea
  private inputHandler: ((input: string) => void) | null = null
  private mdBuffer: string = ''

  constructor(private footerRows = 3) {
    // Created in start(), not constructor
  }

  async start(): Promise<void> {
    this.terminal = Terminal.create({
      splitFooter: true,
      footerRows: this.footerRows,
    })

    // Scrollback area (takes remaining space)
    this.scrollback = this.terminal.append(new ScrollBox({ scrollable: true }))

    // Status bar (row 1 of footer)
    this.statusBar = this.terminal.append(new Box({ height: 1 }))
    this.statusBar.append(new Text({ content: 'MMA — waiting...' }))

    // Input (rows 2-3 of footer)
    this.input = this.terminal.append(new Textarea({
      height: 2,
      placeholder: 'MMA> ',
      history: true,
      multiline: true,
      submitKey: 'enter',  // Ctrl+Enter for newline in multiline
    }))

    this.input.on('submit', (value: string) => {
      if (this.inputHandler) this.inputHandler(value)
    })

    this.terminal.render()
  }

  write(text: string): void {
    this.scrollback.append(new Text({ content: text }))
    this.scrollback.scrollToBottom()
    this.terminal.render()
  }

  writeLine(text: string): void {
    this.write(text + '\n')
  }

  writeMarkdown(chunk: string): void {
    this.mdBuffer += chunk
    if (!this.markdown) {
      this.markdown = this.scrollback.append(
        new Markdown({ content: '', streaming: true })
      )
    }
    this.markdown.content = this.mdBuffer
    this.scrollback.scrollToBottom()
    this.terminal.render()
  }

  commitMarkdown(): void {
    this.mdBuffer = ''
    this.markdown = null
  }

  updateStatus(info: StatusInfo): void {
    const parts = [
      info.provider && `${info.provider}/${info.model}`,
      info.tokens && `${info.tokens}/${info.contextWindow}`,
      info.step && `step ${info.step}/${info.maxSteps}`,
    ].filter(Boolean)
    this.statusBar.children[0].content = parts.join(' │ ')
    this.terminal.render()
  }

  onInput(handler: (input: string) => void): void {
    this.inputHandler = handler
  }

  stop(): void {
    this.terminal?.dispose()
  }
}
```

### `src/tui/index.ts` — Factory

```ts
import type { Renderer } from './types.js'

export type { Renderer, StatusInfo, KeyEvent } from './types.js'

export async function createRenderer(mode: 'readline' | 'tui'): Promise<Renderer> {
  if (mode === 'tui') {
    const { OpenTuiRenderer } = await import('./opentui-renderer.js')
    const r = new OpenTuiRenderer()
    await r.start()
    return r
  }
  const { ReadlineRenderer } = await import('./readline-renderer.js')
  const r = new ReadlineRenderer()
  await r.start()
  return r
}
```

---

## 3. Modifications to Existing Files

### `src/cli.ts`

**Changes:**
1. Add `--tui` flag to program options
2. Pass `rendererMode` to `runRepl()` and `runAgentLoop()`

```
Line 37 (options block):  add .option('--tui', 'enable OpenTUI terminal interface')
Line 329 (repl call):      runRepl(provider, registry, modelLabel, rendererMode)
Line 320/327 (agent loop):  runAgentLoop(provider, registry, prompt, undefined, undefined, rendererMode)
```

New variable before the branching logic:
```ts
const rendererMode = program.getOptionValue('tui') ? 'tui' as const : 'readline' as const;
```

### `src/agent/loop.ts`

**Changes:** Replace all `process.stdout.write()`, `console.log()`, `console.error()` calls with `renderer.write*()` methods.

1. `doChat()` (line 341): Add `renderer: Renderer` parameter. Replace:
   - `process.stdout.write(theme.spinner())` → `renderer.writeInfo(theme.spinner())`
   - `process.stdout.write(CLEAR_LINE)` → (noop in TUI, handled by markdown streaming)
   - `process.stdout.write(buf)` → `renderer.writeMarkdown(buf)` (for plain text) or `renderer.write(buf)` 
   - The `buf` streaming logic (lines 366-393) stays the same but routes through renderer
   - `console.log()` at end → `renderer.commitMarkdown()`
   - `console.log(theme.timingLine(...))` → `renderer.writeInfo(theme.timingLine(...))`

2. `runAgentLoop()` (line 423): Add `rendererMode` parameter. Create renderer at start:
   ```ts
   const renderer = await createRenderer(rendererMode)
   ```
   Replace all `console.log()` calls with appropriate `renderer.write*()`:
   - Skill loading messages → `renderer.writeInfo()`
   - File loading messages → `renderer.writeInfo()`
   - Context usage → `renderer.updateStatus()` + `renderer.writeInfo()`
   - Compact messages → `renderer.writeWarning()`
   - Tool header → `renderer.writeToolHeader()`
   - Tool timing → `renderer.writeToolResult()`
   - Error messages → `renderer.writeError()`

3. Signature change:
   ```ts
   export async function runAgentLoop(
     provider: LLMProvider,
     registry: ToolRegistry,
     prompt: string,
     contextManager?: ContextManager,
     previousMessages?: ChatMessage[],
     rendererMode: 'readline' | 'tui' = 'readline',
   ): Promise<AgentLoopResult>
   ```

### `src/repl.ts`

**Changes:** Replace readline interaction with Renderer abstraction.

1. Add `rendererMode` parameter to `runRepl()`:
   ```ts
   export async function runRepl(
     provider: LLMProvider,
     registry: ToolRegistry,
     modelLabel: string,
     rendererMode: 'readline' | 'tui' = 'readline',
   ): Promise<void>
   ```

2. Create renderer:
   ```ts
   const renderer = await createRenderer(rendererMode)
   ```

3. Replace `rl.question()` input with `renderer.onInput()` callback pattern.

4. Replace all `console.log()` calls with `renderer.write*()` methods.

5. The slash command dispatch (lines 371-466) stays in repl.ts — it's the REPL's responsibility. Only output routing changes.

6. The `runAgentLoop()` calls pass through `rendererMode`:
   ```ts
   const result = await runAgentLoop(provider, registry, line, undefined, conversationHistory, rendererMode)
   ```

### `src/config/types.ts`

Add `tui` to the config type if we want persistent TUI preference:
```ts
// In MmaConfig or similar:
tui?: boolean  // default false
```

### `package.json`

Add optional dependency:
```json
"optionalDependencies": {
  "opentui": "^0.1.0"
}
```

This ensures `mma` installs cleanly even without OpenTUI. The `--tui` flag is only available when the package is installed.

---

## 4. Data Flow

### Current Flow (readline)
```
User input → rl.question() → runAgentLoop() → doChat() → process.stdout.write()
                                ↓
                          Tool calls → console.log()
                                ↓
                          Return to rl.question()
```

### New Flow (TUI)
```
User input → textarea 'submit' event → renderer.onInput callback → runAgentLoop() → doChat() → renderer.writeMarkdown()
                                          ↓
                                    Tool calls → renderer.writeToolHeader() / renderer.writeToolResult()
                                          ↓
                                    Status → renderer.updateStatus()
                                          ↓
                                    Return to textarea
```

### Runtime Detection
```ts
// In createRenderer()
async function createRenderer(mode: 'readline' | 'tui'): Promise<Renderer> {
  if (mode === 'tui') {
    try {
      const { OpenTuiRenderer } = await import('./opentui-renderer.js')
      const r = new OpenTuiRenderer()
      await r.start()
      return r
    } catch (e) {
      // OpenTUI not installed or not compatible
      console.error('OpenTUI not available. Falling back to readline.')
      console.error(`  Install: npm install opentui`)
      console.error(`  Or run: mma (without --tui)`)
      const { ReadlineRenderer } = await import('./readline-renderer.js')
      const r = new ReadlineRenderer()
      await r.start()
      return r
    }
  }
  // ... readline fallback
}
```

---

## 5. Phase Breakdown

### Phase 1: Renderer Interface + ReadlineRenderer (no behavior change)
**Goal:** Wrap current output behind an interface. All existing behavior preserved.

**Files created:**
- `src/tui/types.ts` — Renderer interface
- `src/tui/readline-renderer.ts` — wraps console.log/process.stdout
- `src/tui/index.ts` — factory

**Files modified:**
- `src/agent/loop.ts` — add `renderer` param to `doChat()`, replace direct output
- `src/repl.ts` — add `renderer` param, use ReadlineRenderer
- `src/cli.ts` — no change yet (default to readline)

**Verification:**
```bash
npm test                        # all existing tests pass
npm run mma "hello"             # one-shot mode works unchanged
npm run mma                     # REPL works unchanged
```

### Phase 2: OpenTUI Renderer (new backend)
**Goal:** Implement TUI renderer, wire up --tui flag.

**Files created:**
- `src/tui/opentui-renderer.ts` — OpenTUI implementation

**Files modified:**
- `src/cli.ts` — add --tui option, pass mode through
- `src/repl.ts` — pass rendererMode to runAgentLoop
- `package.json` — add opentui as optional dependency

**Verification:**
```bash
npm install opentui             # install the package
npm run mma -- --tui            # launches TUI mode
npm run mma "hello" -- --tui    # one-shot in TUI (falls back to readline — by design)
npm run mma                     # still works without --tui
```

### Phase 3: Streaming Markdown + Status Bar
**Goal:** LLM streaming renders as live Markdown in TUI. Status bar shows live info.

**Files modified:**
- `src/tui/opentui-renderer.ts` —完善 streaming markdown, status updates
- `src/agent/loop.ts` — emit status updates at each step

**Verification:**
```bash
npm run mma -- --tui
# Type a question, observe:
# - Markdown streams incrementally
# - Status bar shows model/tokens/step
# - Tool calls display in scrollback
# - Input accepts multiline
```

### Phase 4: Polish + Edge Cases
**Goal:** Handle interrupts, resize, question/answer flow, diff display.

**Files modified:**
- `src/tui/opentui-renderer.ts` — SIGINT handling, resize, focus management
- `src/repl.ts` — question/answer flow works in TUI mode
- `src/agent/loop.ts` — diff display for file edits (optional)

---

## 6. Verification Steps

### Per-Phase

**Phase 1 (ReadlineRenderer):**
- [ ] `npm test` — all tests pass
- [ ] `npm run mma "create a file test.txt"` — one-shot works
- [ ] `npm run mma` → type `/help` → see help text
- [ ] `npm run mma` → type a question → agent responds
- [ ] `npm run mma` → type `/exit` → session saved, exits
- [ ] SIGINT during agent loop → auto-saves session
- [ ] Tool calls display with timing
- [ ] Context usage shows in agent loop output

**Phase 2 (OpenTUI):**
- [ ] `mma --tui` launches TUI without crash
- [ ] `mma` (no --tui) still uses readline
- [ ] Missing opentui package → graceful fallback to readline
- [ ] Input accepts text, Enter submits
- [ ] Scrollback area receives output
- [ ] Status bar renders

**Phase 3 (Streaming):**
- [ ] LLM response streams as Markdown in scrollback
- [ ] Tool call headers display correctly
- [ ] Status bar updates: model name, token count, step number
- [ ] Multiline input works (Ctrl+Enter for newline)
- [ ] Input history (up/down arrows)

**Phase 4 (Polish):**
- [ ] Ctrl+C during agent loop → graceful stop
- [ ] Terminal resize → layout adjusts
- [ ] `/resume` works in TUI mode
- [ ] Slash commands output to scrollback
- [ ] Question/answer flow works (model asks question → input captures answer)

### Integration Test Scenarios

1. **One-shot mode**: `mma "list files in src/"` — unchanged behavior
2. **REPL basic**: `mma` → ask question → get answer → `/exit`
3. **REPL TUI**: `mma --tui` → same flow in TUI
4. **REPL TUI streaming**: `mma --tui` → ask complex question → observe Markdown streaming
5. **REPL TUI tools**: `mma --tui` → ask to create a file → observe tool header + result in scrollback
6. **REPL TUI question**: `mma --tui` → ask question that triggers model's `question` tool → answer captured via input
7. **REPL TUI slash**: `mma --tui` → `/help`, `/memory`, `/sessions` → output in scrollback
8. **Fallback**: uninstall opentui → `mma --tui` → graceful fallback to readline
9. **Config**: `mma --tui --provider lmstudio --model qwen3.5-9b` → TUI with specific provider
10. **SIGINT**: `mma --tui` → Ctrl+C → session auto-saved → exits cleanly

---

## 7. Key Design Decisions

1. **Renderer is per-session, not global**: Created at start of `runRepl()` or `runAgentLoop()`, passed as parameter. No global singleton.

2. **Dynamic import for OpenTUI**: `await import('./opentui-renderer.js')` — avoids hard dependency. Works with ESM.

3. **ReadlineRenderer is a thin shim**: Zero behavior change. Every method maps 1:1 to current console.log/process.stdout calls.

4. **Markdown streaming is separate from write()**: `writeMarkdown(chunk)` accumulates into a Markdown component; `commitMarkdown()` finalizes it. This gives OpenTUI the incremental updates it needs.

5. **Status updates are pull-based**: `updateStatus()` called at well-defined points (start of step, after tool execution), not on every token.

6. **One-shot mode never uses TUI**: `mma "prompt"` always uses readline-style output. TUI is only for interactive REPL.

7. **ThemeEngine remains unchanged**: ReadlineRenderer uses it for ANSI coloring. OpenTUI uses OpenTUI's own styling (Yoga + component colors). ThemeEngine is still available for any text-based output in TUI mode.

---

## 8. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| OpenTUI not installed | Dynamic import with try/catch, graceful fallback |
| OpenTUI API changes | Pin version in package.json, isolate in opentui-renderer.ts |
| readline regression | Phase 1 is pure refactor — no behavior change, verified by existing tests |
| Streaming performance | Markdown component handles incremental updates; no full re-renders |
| Terminal resize | OpenTUI's Yoga layout handles this; explicit resize handler as backup |
| Ctrl+C handling | Renderer exposes `stop()`, called in SIGINT handler and process exit |
