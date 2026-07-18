# Agent Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three operating modes (`fast`, `base`, `pro`) to MMA agent with REPL `/mode` command, system prompt modification, skill blocking in fast mode, context window enforcement in pro mode, and mode indicator in prompt.

**Architecture:** A new `AgentMode` type (`'fast' | 'base' | 'pro'`) flows from REPL → history → agent loop → system prompt. Each mode modifies `buildSystemPrompt()` output and controls skill availability. The REPL stores mode in-memory (session only, not persisted). Ink and Readline renderers both show current mode in the prompt prefix.

**Tech Stack:** TypeScript/ESM, vitest for tests, existing LLM provider for integration tests (qwen/qwen3.5-9b via LM Studio/Ollama)

---

### Task 1: AgentMode type + config defaults

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/config.ts`

- [ ] **Step 1: Add AgentMode type to config/types.ts**

Add after the existing imports:
```typescript
export type AgentMode = 'fast' | 'base' | 'pro';
```

Add `mode` to `AgentConfig`:
```typescript
export interface AgentConfig {
  maxSteps: number;
  autoCompact: boolean;
  compactThreshold: number;
  toolTimeout: number;
  maxOutputLength: number;
  showThinking?: boolean;
  mode?: AgentMode;
}
```

- [ ] **Step 2: Add default mode to config/config.ts**

In `DEFAULT_CONFIG.agent`, add:
```typescript
mode: 'base',
```

- [ ] **Step 3: Run build check**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config/types.ts src/config/config.ts
git commit -m "feat: add AgentMode type to config (fast|base|pro)"
```

---

### Task 2: System prompt modification per mode

**Files:**
- Modify: `src/agent/system-prompt.ts`

- [ ] **Step 1: Modify buildSystemPrompt signature**

Add `mode` parameter:
```typescript
import type { AgentMode } from '../config/types.js';

export function buildSystemPrompt(extraSkills?: Skill[], mode?: AgentMode): string {
```

- [ ] **Step 2: Add mode-based modifications**

After `skillsHint` block, add:
```typescript
const modeBlock = mode === 'fast'
  ? `\n## Mode: Fast\n⚡ Fast mode — execute tasks directly without planning or loading skills. Skills are not available in this mode. Proceed immediately.`
  : mode === 'pro'
  ? `\n## Mode: Pro\n🔍 Pro mode — before starting work on any task, you MUST first run a @grill-me session to clarify requirements. Suggest the user to add @grill-me, then use it to refine the task before execution. Minimum context window: 64000.`
  : '';
```

Modify the `base` assembly:
```typescript
const base = mode === 'fast'
  ? [header, platformBlock, sysInfo, memory, userProfile, projectMap, agentsBlock, modeBlock].filter(Boolean).join('\n')
  : [header, platformBlock, sysInfo, memory, userProfile, projectMap, agentsBlock, skillsHint, modeBlock].filter(Boolean).join('\n');
```

- [ ] **Step 3: Update cache key**

```typescript
const key = `${process.cwd()}:${mode || 'base'}:${extraSkills?.map(s => s.name).sort().join(',') || ''}`;
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/system-prompt.ts
git commit -m "feat: add mode-based system prompt (fast/pro modify skills and instructions)"
```

---

### Task 3: Pass mode through agent loop

**Files:**
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: Add mode parameter to runAgentLoop**

```typescript
import type { AgentMode } from '../config/types.js';

export async function runAgentLoop(
  ...
  options?: { quiet?: boolean; showThinking?: boolean; mode?: AgentMode },
): Promise<AgentLoopResult> {
```

- [ ] **Step 2: Pass mode to buildSystemPrompt**

```typescript
const systemPrompt = buildSystemPrompt(loadedSkills.length > 0 ? loadedSkills : undefined, options?.mode);
```

- [ ] **Step 3: Block skill auto-loading in fast mode**

Wrap auto-loading block with:
```typescript
if (options?.mode !== 'fast') {
  // ... existing skill auto-loading code
}
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/loop.ts
git commit -m "feat: pass mode through agent loop, block skills in fast mode"
```

---

### Task 4: Pass mode through history

**Files:**
- Modify: `src/repl/history.ts`

- [ ] **Step 1: Add mode parameter to send()**

```typescript
async send(
  ...,
  options?: { quiet?: boolean; showThinking?: boolean; mode?: AgentMode },
): Promise<AgentLoopResult> {
```

- [ ] **Step 2: Pass mode to runAgentLoop**

The existing `options` object is already passed to `runAgentLoop`.

- [ ] **Step 3: Commit**

```bash
git add src/repl/history.ts
git commit -m "feat: pass mode through ConversationHistory.send()"
```

---

### Task 5: REPL /mode command + mode state

**Files:**
- Modify: `src/repl/index.ts`
- Modify: `src/repl/commands.ts`
- Modify: `src/llm/provider.ts`
- Modify: `src/llm/openai-compat.ts`

- [ ] **Step 1: Add mode state and /mode handling in repl/index.ts**

Add `let currentMode: AgentMode = 'base';` in `runRepl()`.

Add `/mode` handler as closure:
```typescript
function cmdMode(args: string, ctx: CommandContext): void {
  const mode = args.trim().toLowerCase() as AgentMode;
  if (!['fast', 'base', 'pro'].includes(mode)) {
    ctx.renderer.writeError('  Usage: /mode fast|base|pro');
    return;
  }
  currentMode = mode;
  ctx.renderer.writeSuccess(`  Mode switched to: ${mode}`);
  const descriptions: Record<AgentMode, string> = {
    fast: '  ⚡ Быстрое выполнение: планирование и скилы отключены, урезанный промпт',
    base: '  · Стандартный режим: все инструменты и функции доступны',
    pro: '  🔍 Pro-режим: обязательное использование @grill-me, контекст ≥64K',
  };
  ctx.renderer.writeDim(descriptions[mode]);
  if (mode === 'pro') {
    const currentCtx = ctx.provider.contextWindow;
    if (currentCtx < 64000) {
      ctx.renderer.writeWarning(`  ⚠ Mode 'pro' requires ≥64K context. Current: ${currentCtx}. Auto-setting to 64000.`);
      ctx.provider.contextWindow = 64000;
    }
  }
  if (ctx.renderer.setMode) {
    ctx.renderer.setMode(mode === 'base' ? '' : mode);
  }
}
```

Change prompt: `const promptMsg = currentMode === 'base' ? 'MMA> ' : \`[${currentMode}] MMA> \``

Pass mode to `history.send()`:
```typescript
const result = await history.send(line, provider, registry, renderer, modelLabel, {
  showThinking: options?.showThinking,
  mode: currentMode,
});
```

- [ ] **Step 2: Add /mode to commands.ts**

```typescript
{ name: 'mode', description: 'switch agent mode (fast|base|pro)', handler: () => {} },
```

In help: `  /mode fast|base|pro — switch agent mode`

- [ ] **Step 3: Make contextWindow writable**

In `src/llm/provider.ts`: remove `readonly` from `contextWindow`.
In `src/llm/openai-compat.ts`: remove `readonly` from `contextWindow`.

- [ ] **Step 4: Commit**

```bash
git add src/repl/index.ts src/repl/commands.ts src/llm/provider.ts src/llm/openai-compat.ts
git commit -m "feat: add /mode REPL command with mode switching, context window enforcement"
```

---

### Task 6: Mode indicator in Ink UI

**Files:**
- Modify: `src/ui/renderer.ts`
- Modify: `src/ui/readline-renderer.ts`
- Modify: `src/ui/ink/renderer.ts`
- Modify: `src/ui/ink/components/App.tsx`
- Modify: `src/ui/ink/components/PromptInput.tsx`

- [ ] **Step 1: Add setMode to OutputRenderer**

```typescript
setMode?(mode: string): void;
```

- [ ] **Step 2: Implement in ReadlineRenderer**

```typescript
setMode(_mode: string): void {}
```

- [ ] **Step 3: Add SET_MODE to App.tsx**

Add `mode: string` to state, `SET_MODE` action, pass to PromptInput.

- [ ] **Step 4: Add mode prop to PromptInput.tsx**

```typescript
mode?: string;
// In render:
{mode ? <Text dim>[{mode}] </Text> : null}{'MMA> '}
```

- [ ] **Step 5: Implement in InkRenderer**

```typescript
setMode(mode: string): void {
  this.dispatch({ type: 'SET_MODE', mode });
}
```

- [ ] **Step 6: Commit**

```bash
git add src/ui/
git commit -m "feat: add mode indicator in Ink UI"
```

---

### Task 7: Unit tests

**Files:**
- Create: `tests/modes.test.ts`

7 tests covering:
- base mode includes skills block
- fast mode removes skills block
- pro mode includes grill-me
- base is default when mode undefined
- fast mode with extraSkills still hides skills
- pro mode with extraSkills includes both
- fast mode doesn't list installed skills

- [ ] **Step 1: Write and run tests**

```bash
npx vitest tests/modes.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add tests/modes.test.ts
git commit -m "test: add unit tests for agent mode system prompt variants"
```

---

### Task 8: Integration tests

**Files:**
- Modify: `tests/agent-integration.test.ts`

3 tests:
- fast mode prompt has no skills
- pro mode prompt has grill-me
- model responds in fast mode (real model)

- [ ] **Step 1: Run integration tests**

```bash
npx vitest tests/agent-integration.test.ts
```

- [ ] **Step 2: Commit**

```bash
git add tests/agent-integration.test.ts
git commit -m "test: add integration tests for agent modes with real model"
```

---

### Task 9: Final verification

- [ ] **Step 1: Run full build**
```bash
npm run build
```

- [ ] **Step 2: Run all tests**
```bash
npm run test:all
```

- [ ] **Step 3: Final commit**
```bash
git add -A
git commit -m "feat: agent modes (fast/base/pro) complete with mode indicator, context enforcement, and tests"
```
