# Ink UI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ReadlineRenderer with ink-based React renderer, add theme management system for both REPL and agent.

**Architecture:** OutputRenderer interface stays unchanged. InkRenderer implements the same interface but renders via React/ink components. Theme system adds loadThemeConfig() + list/switch/install/remove functions, plus `/theme` REPL command and agent `theme` tool.

**Tech Stack:** TypeScript/ESM, ink ^5.0.0, React ^18.3.0, picocolors (existing), node:readline (unchanged fallback)

---

### Task 1: Dependencies + Styling refactor (loadThemeConfig, listThemes, switchTheme)

**Files:**
- Modify: `package.json`
- Modify: `src/styling/loader.ts`
- Modify: `src/styling/index.ts`

- [ ] **Step 1: Add dependencies**

```bash
cd /project && npm install ink@^5.0.0 react@^18.3.0
```

- [ ] **Step 2: Add loadThemeConfig, listThemes, installTheme, removeTheme to loader.ts**

```typescript
// src/styling/loader.ts — add after BUILT_IN_THEMES

export function loadThemeConfig(name?: string): ThemeConfig {
  const builtIn = BUILT_IN_THEMES[name || 'light'] || BUILT_IN_THEMES.light;
  const custom = loadJsonTheme(name || 'light');
  return custom ? mergeTheme(builtIn, custom) : builtIn;
}

export function listThemes(): string[] {
  const builtIn = Object.keys(BUILT_IN_THEMES);
  let custom: string[] = [];
  try {
    custom = readdirSync(THEMES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch { /* no custom themes dir */ }
  return [...builtIn, ...custom];
}

export function installTheme(name: string, content: string): string {
  const filePath = join(THEMES_DIR, `${name}.json`);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function removeTheme(name: string): boolean {
  const filePath = join(THEMES_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}
```

Add `import { readdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'` at the top if not present.

- [ ] **Step 3: Refactor loadTheme to use loadThemeConfig**

```typescript
// src/styling/loader.ts — replace loadTheme body
export function loadTheme(name: string = 'light'): ThemeEngine {
  return new ThemeEngine(loadThemeConfig(name));
}
```

- [ ] **Step 4: Add listThemes, switchTheme, resetTheme to styling/index.ts**

```typescript
// src/styling/index.ts — add exports
export function listThemes(): string[] {
  const { listThemes } = require('./loader.js');
  return listThemes();
}

export function switchTheme(name: string): ThemeEngine {
  _theme = loadTheme(name);
  return _theme;
}

export function resetTheme(name?: string): void {
  _theme = null;
}
```

- [ ] **Step 5: Verify build**

Run: `cd /project && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json src/styling/loader.ts src/styling/index.ts
git commit -m "feat: add loadThemeConfig, listThemes, switchTheme to styling module"
```

---

### Task 2: Theme REPL command + agent tool wiring

**Files:**
- Modify: `src/repl/commands.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/system-prompt.ts`

- [ ] **Step 1: Add /theme slash command to commands.ts**

Add to `getSlashCommands()`:
```typescript
{ name: 'theme', description: 'theme management (list/switch/show/install/create/remove)', handler: cmdTheme },
```

Add imports:
```typescript
import { listThemes, switchTheme } from '../styling/index.js';
import { loadThemeConfig, installTheme, removeTheme } from '../styling/loader.js';
```

Add handler:
```typescript
function cmdTheme(args: string, ctx: CommandContext): void {
  const theme = getTheme();
  const parts = args.trim().split(/\s+/);
  const subcmd = parts[0] || 'list';
  const name = parts.slice(1).join(' ');

  switch (subcmd) {
    case 'list': {
      const allThemes = listThemes();
      ctx.renderer.writeInfo(`  Available themes (${allThemes.length}):`);
      for (const t of allThemes) {
        const marker = t === loadThemeConfig().name ? theme.success(' ← active') : '';
        ctx.renderer.writeLine(`    ${theme.highlight(t)}${marker}`);
      }
      break;
    }
    case 'show': {
      const config = loadThemeConfig();
      ctx.renderer.writeInfo(`  Current theme: ${theme.highlight(config.name)}`);
      ctx.renderer.writeLine(`    Colors: ${Object.keys(config.colors).length} keys`);
      ctx.renderer.writeLine(`    Icons: ${Object.keys(config.icons).length} keys`);
      break;
    }
    case 'create': {
      if (!name) { ctx.renderer.writeInfo('  Usage: /theme create <name>'); break; }
      const current = loadThemeConfig();
      current.name = name;
      const path = installTheme(name, JSON.stringify(current, null, 2));
      ctx.renderer.writeSuccess(`  Theme "${name}" created (${path})`);
      break;
    }
    case 'install': {
      const [themeName, url] = parts.slice(1);
      if (!themeName || !url) { ctx.renderer.writeInfo('  Usage: /theme install <name> <url>'); break; }
      ctx.renderer.writeDim(`  Downloading from ${url}...`);
      // synchronously fetch — simple, works for now
      try {
        const resp = execSync(`curl -s "${url}"`, { encoding: 'utf-8', timeout: 10000 });
        JSON.parse(resp); // validate
        const path = installTheme(themeName, resp);
        ctx.renderer.writeSuccess(`  Theme "${themeName}" installed (${path})`);
      } catch (e: any) {
        ctx.renderer.writeError(`  Failed to install: ${e.message}`);
      }
      break;
    }
    case 'remove': {
      if (!name) { ctx.renderer.writeInfo('  Usage: /theme remove <name>'); break; }
      if (!removeTheme(name)) { ctx.renderer.writeError(`  Theme "${name}" not found`); break; }
      ctx.renderer.writeSuccess(`  Theme "${name}" removed`);
      break;
    }
    default: {
      // switch to theme by name
      const allThemes = listThemes();
      if (!allThemes.includes(subcmd)) { ctx.renderer.writeError(`  Unknown theme "${subcmd}". Use /theme list`); break; }
      const config = loadConfig();
      config.theme = subcmd;
      saveConfig(config);
      switchTheme(subcmd);
      // also reset ink theme cache if ink renderer is active
      const { resetInkTheme } = await import('../ui/ink/theme.js');
      resetInkTheme();
      ctx.renderer.writeSuccess(`  Theme switched to "${subcmd}"`);
      break;
    }
  }
}
```

Note: `cmdTheme` needs to be `async` for the install/default cases. Make it `async function cmdTheme(...)`.

- [ ] **Step 2: Add `theme` to VALID_TOOLS in loop.ts**

```typescript
// src/agent/loop.ts — line 96
const VALID_TOOLS = new Set(['bash', 'plan', 'todo', 'question', 'approve',
  'read_file', 'write_file', 'edit_file', 'list_dir', 'create_dir',
  'delete_file', 'copy_file', 'move_file', 'file_info', 'glob_search',
  'grep_search', 'tree', 'web_search', 'web_fetch', 'theme']);
```

- [ ] **Step 3: Add theme handler in loop.ts**

Add after the `approve` handler block (before `} else if (isBash && ...)`):

```typescript
} else if (parsed.name === 'theme') {
  const action = String(parsed.arguments.action || 'list');
  const name = String(parsed.arguments.name || '');
  const url = String(parsed.arguments.url || '');

  switch (action) {
    case 'list': {
      const allThemes = listThemes();
      const current = loadThemeConfig().name;
      toolOutput = `Available themes (${allThemes.length}):\n`;
      for (const t of allThemes) {
        toolOutput += `  ${t}${t === current ? ' (active)' : ''}\n`;
      }
      break;
    }
    case 'show': {
      const config = loadThemeConfig();
      toolOutput = `Theme: ${config.name}\nColors: ${JSON.stringify(config.colors, null, 2)}\nIcons: ${JSON.stringify(config.icons, null, 2)}`;
      break;
    }
    case 'switch': {
      const allThemes = listThemes();
      if (!allThemes.includes(name)) {
        toolOutput = `Unknown theme "${name}". Available: ${allThemes.join(', ')}`;
        toolExitCode = 1;
        break;
      }
      const appConfig = loadConfig();
      appConfig.theme = name;
      saveConfig(appConfig);
      switchTheme(name);
      const { resetInkTheme } = await import('./ui/ink/theme.js');
      resetInkTheme();
      toolOutput = `Theme switched to "${name}"`;
      break;
    }
    case 'install': {
      if (!name || !url) {
        toolOutput = 'Usage: theme install <name> <url>';
        toolExitCode = 1;
        break;
      }
      try {
        const resp = await fetch(url);
        const text = await resp.text();
        JSON.parse(text);
        installTheme(name, text);
        toolOutput = `Theme "${name}" installed from ${url}`;
      } catch (e: any) {
        toolOutput = `Failed to install theme: ${e.message}`;
        toolExitCode = 1;
      }
      break;
    }
    case 'remove': {
      if (!removeTheme(name)) {
        toolOutput = `Theme "${name}" not found`;
        toolExitCode = 1;
        break;
      }
      toolOutput = `Theme "${name}" removed`;
      break;
    }
    default:
      toolOutput = 'Unknown theme action. Use: list, show, switch, install, remove';
      toolExitCode = 1;
  }
}
```

Add imports at top of loop.ts:
```typescript
import { listThemes, switchTheme } from '../styling/index.js';
import { loadThemeConfig, installTheme, removeTheme } from '../styling/loader.js';
import { loadConfig, saveConfig } from '../config/config.js';
```

- [ ] **Step 4: Add theme tool to system prompt**

In `src/agent/system-prompt.ts`, in the `TOOL_FORMAT` block, add after the `## Web tools` section:

```
## Theme tool (управление темами):
  {"name":"theme","arguments":{"action":"list"}}
  {"name":"theme","arguments":{"action":"switch","name":"dark"}}
  {"name":"theme","arguments":{"action":"show"}}
  {"name":"theme","arguments":{"action":"install","name":"monokai","url":"https://example.com/monokai.json"}}
  {"name":"theme","arguments":{"action":"remove","name":"monokai"}}

Темы находятся в ~/.mma/themes/. Встроенные: light, dark. Можно установить из URL.
Если пользователь хочет сменить тему — предложи и переключи.
```

- [ ] **Step 5: Verify build**

Run: `cd /project && npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/repl/commands.ts src/agent/loop.ts src/agent/system-prompt.ts
git commit -m "feat: add /theme REPL command and agent theme tool"
```

---

### Task 3: ink/theme.ts bridge

**Files:**
- Create: `src/ui/ink/theme.ts`

- [ ] **Step 1: Create ink/theme.ts**

```typescript
import { loadThemeConfig, type ThemeConfig } from '../../styling/loader.js';

interface InkStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface InkTheme {
  colors: Record<string, InkStyle>;
  icons: Record<string, string>;
  format: { indent: string; indentSize: number };
}

const PICOLOR_TO_INK: Record<string, InkStyle> = {
  dim: { dim: true },
  bold: { bold: true },
  italic: { italic: true },
  underline: { underline: true },
  black: { color: 'black' },
  red: { color: 'red' },
  green: { color: 'green' },
  yellow: { color: 'yellow' },
  blue: { color: 'blue' },
  magenta: { color: 'magenta' },
  cyan: { color: 'cyan' },
  white: { color: 'white' },
  gray: { color: 'gray' },
  bgRed: { backgroundColor: 'red' },
  bgGreen: { backgroundColor: 'green' },
  bgYellow: { backgroundColor: 'yellow' },
  bgBlue: { backgroundColor: 'blue' },
  bgMagenta: { backgroundColor: 'magenta' },
  bgCyan: { backgroundColor: 'cyan' },
  bgWhite: { backgroundColor: 'white' },
};

let _inkTheme: InkTheme | null = null;

export function getInkTheme(): InkTheme {
  if (!_inkTheme) _inkTheme = buildInkTheme();
  return _inkTheme;
}

export function resetInkTheme(): void {
  _inkTheme = null;
}

function buildInkTheme(): InkTheme {
  const config: ThemeConfig = loadThemeConfig() as ThemeConfig;
  const colors: Record<string, InkStyle> = {};
  for (const [key, val] of Object.entries(config.colors)) {
    colors[key] = PICOLOR_TO_INK[val] || {};
  }
  return {
    colors,
    icons: { ...config.icons },
    format: { ...config.format },
  };
}
```

- [ ] **Step 2: Verify import chain**

Run: `cd /project && npm run build`
Expected: Build succeeds (may need to create empty `src/ui/ink/` dir first).

- [ ] **Step 3: Commit**

```bash
git add src/ui/ink/theme.ts
git commit -m "feat: add ink theme bridge (ThemeEngine → ink style props)"
```

---

### Task 4: InkRenderer — core class + App component

**Files:**
- Create: `src/ui/ink/components/App.tsx`
- Create: `src/ui/ink/components/Conversation.tsx`
- Create: `src/ui/ink/components/MessageBlock.tsx`
- Create: `src/ui/ink/components/ToolCallBlock.tsx`
- Create: `src/ui/ink/components/StreamBlock.tsx`
- Create: `src/ui/ink/components/StatusBar.tsx`
- Create: `src/ui/ink/components/Tags.tsx`

**Note:** We start with the components (no PromptInput yet), building up to the full InkRenderer.

- [ ] **Step 1: Create Tags.tsx**

```tsx
import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

export function InfoTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.info}>ℹ {children}</Text>;
}

export function SuccessTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.success}>✓ {children}</Text>;
}

export function WarningTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.warning}>⚠ {children}</Text>;
}

export function ErrorTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.error}>✗ {children}</Text>;
}

export function DimText({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.dim}>{children}</Text>;
}

export function HeadingTag({ children }: { children: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.heading}>{children}</Text>;
}

export function BracketTag({ tag, message }: { tag: string; message: string }) {
  const t = getInkTheme();
  return (
    <Text>
      <Text {...t.colors.dim}>[{tag}]</Text>
      <Text> {message}</Text>
    </Text>
  );
}

export function LineNumbers({ text }: { text: string }) {
  const t = getInkTheme();
  return <Text {...t.colors.lineNumbers}>{text}</Text>;
}
```

- [ ] **Step 2: Create MessageBlock.tsx**

```tsx
import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';
import { DimText } from './Tags.js';

export interface MessageItem {
  type: 'message' | 'info' | 'success' | 'warning' | 'error' | 'dim' | 'heading';
  content: string;
}

const TYPE_COLORS: Record<string, keyof ReturnType<typeof getInkTheme>['colors']> = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
  dim: 'dim',
  heading: 'heading',
};

export function MessageBlock({ item }: { item: MessageItem }) {
  const t = getInkTheme();
  if (item.type === 'message') {
    return (
      <Box>
        <Text>{item.content}</Text>
      </Box>
    );
  }
  const colorKey = TYPE_COLORS[item.type];
  const style = colorKey ? t.colors[colorKey] : {};
  return (
    <Box>
      <Text {...style}>{item.content}</Text>
    </Box>
  );
}

export function FileOutputBlock({ lines, startIndex }: { lines: string[]; startIndex: number }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const lineNum = (startIndex + i).toString().padStart(4);
        return (
          <Box key={i}>
            <LineNumbers text={lineNum} /><Text>| {line}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 3: Create ToolCallBlock.tsx**

```tsx
import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

export interface ToolCallData {
  name: string;
  args: string;
  result: string;
  time: string;
  exitCode?: number;
}

export function ToolCallBlock({ data }: { data: ToolCallData }) {
  const t = getInkTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" marginLeft={1} paddingX={1}>
      <Text>
        <Text {...t.colors.toolName}>tool: {data.name}</Text>
        <Text {...t.colors.dim}> ──</Text>
      </Text>
      <Text {...t.colors.dim}>{data.args}</Text>
      <Text {...t.colors.timing}>⏱ {data.time}{data.exitCode !== undefined ? ` · exit ${data.exitCode}` : ''}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Create StreamBlock.tsx**

```tsx
import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

export function StreamBlock({ content, isReasoning }: { content: string; isReasoning: boolean }) {
  const t = getInkTheme();
  if (isReasoning) {
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Text {...t.colors.dim} italic>{content}</Text>
      </Box>
    );
  }
  return (
    <Box marginLeft={1}>
      <Text>{content}</Text>
    </Box>
  );
}

export function SpinnerLine({ text }: { text?: string }) {
  const t = getInkTheme();
  return (
    <Text>
      <Text {...t.colors.dim}>⏳</Text>
      {text ? <Text> {text}</Text> : null}
    </Text>
  );
}
```

- [ ] **Step 5: Create StatusBar.tsx**

```tsx
import { Box, Text } from 'ink';
import { getInkTheme } from '../theme.js';

interface StatusInfo {
  provider?: string;
  model?: string;
  tokens?: number;
  contextWindow?: number;
  step?: number;
  maxSteps?: number;
}

export function StatusBar({ info, usage }: { info: StatusInfo; usage?: string }) {
  const t = getInkTheme();
  const parts: string[] = [];
  if (info.provider && info.model) {
    parts.push(`${info.provider}/${info.model}`);
  }
  if (info.tokens !== undefined && info.contextWindow !== undefined) {
    parts.push(`${info.tokens}/${info.contextWindow}`);
  }
  if (info.step !== undefined && info.maxSteps !== undefined) {
    parts.push(`step ${info.step}/${info.maxSteps}`);
  }
  if (usage) {
    parts.push(usage);
  }

  return (
    <Box borderStyle="single" borderColor="gray" width="100%" paddingX={1}>
      <Text {...t.colors.dim}>{parts.join(' │ ') || 'MMA — ready'}</Text>
    </Box>
  );
}
```

- [ ] **Step 6: Create Conversation.tsx**

```tsx
import { Box } from 'ink';
import { MessageBlock, type MessageItem } from './MessageBlock.js';
import { ToolCallBlock, type ToolCallData } from './ToolCallBlock.js';

type ConversationEntry =
  | { kind: 'message'; data: MessageItem }
  | { kind: 'tool_call'; data: ToolCallData };

export function Conversation({ entries }: { entries: ConversationEntry[] }) {
  // Show last N entries to avoid overflow
  const visible = entries.slice(-100);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {visible.map((entry, i) => {
        if (entry.kind === 'message') {
          return <MessageBlock key={i} item={entry.data} />;
        }
        return <ToolCallBlock key={i} data={entry.data} />;
      })}
    </Box>
  );
}
```

- [ ] **Step 7: Create App.tsx**

```tsx
import React, { useReducer, useEffect } from 'react';
import { Box } from 'ink';
import { Conversation, type ConversationEntry } from './Conversation.js';
import { StreamBlock, SpinnerLine } from './StreamBlock.js';
import { StatusBar } from './StatusBar.js';
import { BracketTag } from './Tags.js';

interface StatusInfo {
  provider?: string;
  model?: string;
  tokens?: number;
  contextWindow?: number;
  step?: number;
  maxSteps?: number;
}

interface AppState {
  entries: ConversationEntry[];
  streaming: boolean;
  streamingContent: string;
  isReasoning: boolean;
  showSpinner: boolean;
  status: StatusInfo;
  contextUsage: string;
}

type Action =
  | { type: 'ADD_MESSAGE'; kind: 'message'; data: any }
  | { type: 'ADD_TOOL_CALL'; data: any }
  | { type: 'STREAM_CHUNK'; chunk: string }
  | { type: 'STREAM_REASONING'; text: string }
  | { type: 'STREAM_END' }
  | { type: 'SPINNER'; show: boolean }
  | { type: 'STATUS'; info: StatusInfo }
  | { type: 'CONTEXT'; text: string }
  | { type: 'CLEAR' }
  | { type: 'BATCH'; actions: Action[] };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'ADD_MESSAGE':
      return { ...state, entries: [...state.entries, { kind: 'message', data: action.data }] };
    case 'ADD_TOOL_CALL':
      return { ...state, entries: [...state.entries, { kind: 'tool_call', data: action.data }] };
    case 'STREAM_CHUNK':
      return { ...state, streaming: true, streamingContent: state.streamingContent + action.chunk };
    case 'STREAM_REASONING':
      return { ...state, streaming: true, streamingContent: action.text, isReasoning: true };
    case 'STREAM_END':
      return { ...state, streaming: false, streamingContent: '', isReasoning: false };
    case 'SPINNER':
      return { ...state, showSpinner: action.show };
    case 'STATUS':
      return { ...state, status: { ...state.status, ...action.info } };
    case 'CONTEXT':
      return { ...state, contextUsage: action.text };
    case 'CLEAR':
      return { entries: [], streaming: false, streamingContent: '', isReasoning: false, showSpinner: false, status: {}, contextUsage: '' };
    case 'BATCH':
      return action.actions.reduce(reducer, state);
    default:
      return state;
  }
}

const initialState: AppState = {
  entries: [],
  streaming: false,
  streamingContent: '',
  isReasoning: false,
  showSpinner: false,
  status: {},
  contextUsage: '',
};

export interface AppHandle {
  dispatch(action: Action): void;
  setPromptResolve(fn: ((value: string) => void) | null): void;
}

export function App({ onReady }: { onReady: (handle: AppHandle) => void }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    onReady({ dispatch, setPromptResolve: () => {} });
  }, []);

  return (
    <Box flexDirection="column" height="100%">
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <Conversation entries={state.entries} />
        {state.showSpinner && !state.streaming && <SpinnerLine />}
        {state.streaming && <StreamBlock content={state.streamingContent} isReasoning={state.isReasoning} />}
      </Box>
      <StatusBar info={state.status} usage={state.contextUsage} />
    </Box>
  );
}
```

- [ ] **Step 8: Verify build**

Run: `cd /project && npm run build`
Expected: Build succeeds (may need to adjust `tsconfig.json` for JSX).

- [ ] **Step 9: Commit**

```bash
git add src/ui/ink/components/
git commit -m "feat: add ink UI components (App, Conversation, MessageBlock, ToolCallBlock, StreamBlock, StatusBar, Tags)"
```

---

### Task 5: InkRenderer class + PromptInput

**Files:**
- Create: `src/ui/ink/components/PromptInput.tsx`
- Create: `src/ui/ink/renderer.ts`

- [ ] **Step 1: Create PromptInput.tsx**

```tsx
import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { getInkTheme } from '../theme.js';

interface SlashCommandInfo {
  name: string;
  description: string;
}

export function PromptInput({
  commands,
  onSubmit,
}: {
  commands?: SlashCommandInfo[];
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const t = getInkTheme();

  useInput((input, key) => {
    if (key.return && !key.shift) {
      const trimmed = value.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setHistory(h => [trimmed, ...h].slice(0, 50));
      }
      setValue('');
      setCursor(0);
      setHistoryIdx(-1);
      return;
    }

    if (key.return && key.shift) {
      setValue(v => v.slice(0, cursor) + '\n' + v.slice(cursor));
      setCursor(c => c + 1);
      return;
    }

    if (key.tab) {
      // Completion logic
      const line = value.slice(0, cursor);
      const match = line.match(/^\/(\w*)$/);
      if (match && commands) {
        const partial = match[1].toLowerCase();
        const matches = commands
          .filter(c => c.name.startsWith(partial))
          .map(c => '/' + c.name);

        if (matches.length > 0) {
          if (suggestions.length === 0) {
            setSuggestions(matches);
            setSuggestIdx(0);
          } else {
            const nextIdx = (suggestIdx + 1) % matches.length;
            setSuggestIdx(nextIdx);
          }
          // Replace line with selected suggestion
          const selected = matches[suggestions.length > 0 ? suggestIdx : 0];
          setValue(selected + value.slice(cursor));
          setCursor(selected.length);
          return;
        }
      }
      setSuggestions([]);
      return;
    }

    if (key.upArrow) {
      // History navigation (only in empty line or at start)
      const beforeCursor = value.slice(0, cursor);
      if (beforeCursor === '' && history.length > 0) {
        const newIdx = historyIdx < history.length - 1 ? historyIdx + 1 : historyIdx;
        if (newIdx !== historyIdx) {
          setHistoryIdx(newIdx);
          setValue(history[newIdx]);
          setCursor(history[newIdx].length);
        }
      }
      return;
    }

    if (key.downArrow) {
      if (historyIdx >= 0) {
        const newIdx = historyIdx - 1;
        if (newIdx >= 0) {
          setHistoryIdx(newIdx);
          setValue(history[newIdx]);
          setCursor(history[newIdx].length);
        } else {
          setHistoryIdx(-1);
          setValue('');
          setCursor(0);
        }
      }
      return;
    }

    if (key.leftArrow) {
      if (cursor > 0) setCursor(c => c - 1);
      return;
    }

    if (key.rightArrow) {
      if (cursor < value.length) setCursor(c => c + 1);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setValue(v => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor(c => c - 1);
      }
      return;
    }

    if (key.ctrl && input === 'c') {
      process.exit(0);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValue(v => v.slice(0, cursor) + input + v.slice(cursor));
      setCursor(c => c + input.length);
      setSuggestions([]);
    }
  });

  // Show suggestions dropdown
  const showSuggestions = suggestions.length > 0;

  return (
    <Box flexDirection="column" width="100%">
      {showSuggestions && (
        <Box flexDirection="column" marginLeft={1} marginBottom={1}>
          {suggestions.map((s, i) => (
            <Text key={i} inverse={i === suggestIdx} {...t.colors.dim}>{s}</Text>
          ))}
        </Box>
      )}
      <Box width="100%">
        <Text {...t.colors.prompt}>MMA> </Text>
        {/* Render text with cursor */}
        <Text>
          {value.slice(0, cursor)}
          <Text inverse>{value[cursor] || ' '}</Text>
          {value.slice(cursor + 1)}
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Create InkRenderer (renderer.ts)**

```typescript
import { render as inkRender, type RenderResult } from 'ink';
import React from 'react';
import type { OutputRenderer, StatusInfo } from '../renderer.js';
import { App, type AppHandle } from './components/App.js';

interface SlashCommandInfo {
  name: string;
  description: string;
}

export class InkRenderer implements OutputRenderer {
  private handle: AppHandle | null = null;
  private inkResult: RenderResult | null = null;
  private _promptResolve: ((value: string) => void) | null = null;
  private _commands: SlashCommandInfo[] = [];

  readonly abortSignal: AbortSignal | undefined;

  setCommands(cmds: SlashCommandInfo[]): void {
    this._commands = cmds;
  }

  async start(): Promise<void> {
    this.inkResult = inkRender(
      React.createElement(App, {
        onReady: (handle) => { this.handle = handle; },
      })
    );
  }

  destroy(): void {
    this.inkResult?.unmount();
    this.inkResult = null;
    this.handle = null;
  }

  private dispatch(action: any): void {
    this.handle?.dispatch(action);
  }

  write(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: text } });
  }

  writeLine(text?: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: text ?? '' } });
  }

  writeNewline(): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: '' } });
  }

  writeInfo(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'info', content: text } });
  }

  writeSuccess(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'success', content: text } });
  }

  writeWarning(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'warning', content: text } });
  }

  writeError(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'error', content: text } });
  }

  writeDim(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'dim', content: text } });
  }

  writeBracketTag(tag: string, message: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'bracket', tag, message } });
  }

  writeHeading(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'heading', content: text } });
  }

  writeToolHeader(name: string): void {
    this.dispatch({ type: 'ADD_TOOL_CALL', data: { name, args: '', result: '', time: '' } });
  }

  writeToolPreview(toolName: string, argsJson: string): void {
    // We don't update the tool call preview separately — handled via dispatch
  }

  writeToolResult(time: string, exitCode?: number): void {
    // TODO: update last tool call with timing
  }

  writeMarkdownChunk(chunk: string): void {
    this.dispatch({ type: 'STREAM_CHUNK', chunk });
  }

  commitMarkdown(): void {
    this.dispatch({ type: 'STREAM_END' });
    // Add the streamed content as a message entry
    // (the content is already in streamingContent, we need to finalize it)
  }

  writeSpinner(text?: string): void {
    this.dispatch({ type: 'SPINNER', show: true });
  }

  clearSpinner(): void {
    this.dispatch({ type: 'SPINNER', show: false });
  }

  updateContextUsage(text: string): void {
    this.dispatch({ type: 'CONTEXT', text });
  }

  updateStatus(info: StatusInfo): void {
    this.dispatch({ type: 'STATUS', info });
  }

  clear(): void {
    this.dispatch({ type: 'CLEAR' });
  }

  async prompt(msg: string): Promise<string> {
    return new Promise((resolve) => {
      this._promptResolve = resolve;
    });
  }

  writeFileOutput(lines: string[], startIndex = 1): void {
    // Simple text rendering for now
    const text = lines.map((line, i) => {
      const lineNum = (startIndex + i).toString().padStart(4);
      return `${lineNum}| ${line}`;
    }).join('\n');
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: text } });
  }
}
```

- [ ] **Step 3: Verify build**

Run: `cd /project && npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/ui/ink/renderer.ts src/ui/ink/components/PromptInput.tsx
git commit -m "feat: add InkRenderer and PromptInput component"
```

---

### Task 6: Factory wiring + config

**Files:**
- Modify: `src/ui/index.ts`

- [ ] **Step 1: Update factory to support ink mode**

```typescript
// src/ui/index.ts
import type { OutputRenderer, StatusInfo } from './renderer.js'

export type { OutputRenderer, StatusInfo } from './renderer.js'

export interface SlashCommandInfo {
  name: string
  description: string
}

export async function createRenderer(
  commands?: SlashCommandInfo[],
  options?: { mode?: 'readline' | 'ink' }
): Promise<OutputRenderer> {
  const mode = options?.mode || process.env.INK_MODE === '1' ? 'ink' : 'readline';

  if (mode === 'ink') {
    const { InkRenderer } = await import('./ink/renderer.js');
    const r = new InkRenderer();
    if (commands) r.setCommands(commands);
    await r.start();
    return r;
  }

  const { ReadlineRenderer } = await import('./readline-renderer.js');
  const r = new ReadlineRenderer();
  if (commands) r.setCommands(commands);
  await r.start();
  return r;
}
```

- [ ] **Step 2: Verify build**

Run: `cd /project && npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/ui/index.ts
git commit -m "feat: add ink mode to UI factory"
```

---

### Task 7: Add --ink CLI flag + config wiring

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add --ink option to CLI**

In `createCli()`, add to program options:
```typescript
program
  .option('--ink', 'use ink renderer (React terminal UI)');
```

In `program.action` callback, pass to `createRenderer`:
```typescript
const useInk = program.getOptionValue('ink') || config.ui?.mode === 'ink';
// ...
const renderer = await createRenderer(commands, { mode: useInk ? 'ink' : 'readline' });
```

- [ ] **Step 2: Verify build**

Run: `cd /project && npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add --ink CLI flag"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full build**

```bash
cd /project && npm run build
```

- [ ] **Step 2: Run tests**

```bash
cd /project && npm test
```

Expected: All tests pass.

- [ ] **Step 3: Manual smoke test (readline mode)**

```bash
cd /project && node dist/index.js "Привет"
```
Expected: Works as before (readline fallback).

- [ ] **Step 4: Manual smoke test (ink mode)**

```bash
cd /project && node dist/index.js --ink "Привет"
```
Expected: Ink renderer works (may show empty or basic output if no provider configured).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: ink UI integration complete with theme system"
```
