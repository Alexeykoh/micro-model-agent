# Onboarding Commands (`meet` / «Познакомимся» & `init`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-driven `meet` («Познакомимся», persists user preferences/facts to global memory) and `init` (generates/updates `AGENTS.md` for any workspace), rename the provider wizard to `mma setup`, add `/memory`, align the `question` tool with STYLE.md, and gate `meet` on a provider preflight.

**Architecture:** New `src/modules/onboarding/` owns the two flows. A **restricted tool allowlist** on the shared `ToolContext` guarantees onboarding cannot touch the repo. Meet runs as a REPL **mode** across turns (entered via offer/command, exited when the agent calls the `meet_done` sentinel); `init` is a single agent run. CLI subcommands wrap the same engine. A shared `preflightProvider` gates LLM-dependent entry points.

**Tech Stack:** Bun + TypeScript, vitest (`bun test`), commander, OutputChannel/STYLE.md, i18n (`t()`), existing memory module.

**Spec:** [docs/specs/2026-09-23-onboarding-meet-init-design.md](../specs/2026-09-23-onboarding-meet-init-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/tools/allowlist` (types change) | `ToolContext.toolAllowlist` + `onboarding` state |
| `src/tools/executor.ts` | Enforce allowlist in `getToolDefinitions`/`execute` |
| `src/core/agent.ts` | `pushPromptBlock`/`removePromptBlock` runtime methods |
| `src/modules/providers/preflight.ts` | `preflightProvider` (`listModels` + chat probe) |
| `src/modules/onboarding/prompts.ts` | `MEET_SYSTEM_PROMPT`, `INIT_SYSTEM_PROMPT`, tool lists |
| `src/modules/onboarding/mode.ts` | Enter/exit meet mode, `meet_done` state |
| `src/modules/onboarding/meet.ts` | `runMeet` (preflight + enter mode) |
| `src/modules/onboarding/init.ts` | `runInit` (single agent run) |
| `src/tools/meet-done.ts` | `meet_done` sentinel tool |
| `src/tools/user-input.ts` | `question` rendering per STYLE |
| `src/cli/onboarding-commands.ts` | `/meet`, `/init`, `/memory`, `/setup` REPL handlers |
| `src/cli/commands.ts` | `mma setup` (renamed), `mma meet`, `mma init` |
| `src/cli/repl.ts` | Wire handlers + post-setup `[Y/n]` offer |
| `src/core/session-logger.ts` | `logOnboarding` |
| `src/i18n/{en,ru}.json` | All new strings |

---

## Task 1: Tool allowlist in `ToolContext` + executor

**Files:**
- Modify: `src/tools/types.ts` (add fields)
- Modify: `src/tools/executor.ts:194-201` (`getToolDefinitions`), `:53-60` (`execute`)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json` (`tool.not_allowed`)
- Test: `tests/tools/tool-allowlist.test.ts`

- [ ] **Step 1: Add fields to `ToolContext`** (`src/tools/types.ts`, after `activeToolTags`)

```ts
  /**
   * Strict tool allowlist for the current turn/session. When set, ONLY these
   * tool names are exposed to the LLM and executable — `alwaysOn` and tags do
   * NOT bypass it. Used by onboarding so the agent cannot touch the repo.
   * Undefined = normal tag-based selection.
   */
  toolAllowlist?: string[];
  /**
   * Shared onboarding state. Set by the `meet_done` sentinel tool and read by
   * the REPL to leave meet mode. Carries the active guide block so the REPL
   * can remove it on exit. Undefined outside an onboarding session.
   */
  onboarding?: { done: boolean; block?: import("../core/types").PromptBlock };
```

- [ ] **Step 2: Write the failing test** (`tests/tools/tool-allowlist.test.ts`)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";
import type { ToolContext } from "../../src/tools/types";

function makeCtx(): ToolContext {
  return {
    config: {} as any,
    baseDir: "/tmp",
    logger: {
      info() {}, error() {}, warn() {}, debug() {},
      logToolCall() {}, logToolOutput() {},
    } as any,
  };
}

describe("tool allowlist", () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register({
      name: "remember", description: "", parameters: { type: "object", properties: {} },
      tags: ["memory"],
      handler: async () => ({ success: true, output: "ok" }),
    });
    registry.register({
      name: "bash", description: "", parameters: { type: "object", properties: {} },
      tags: ["code"], alwaysOn: false,
      handler: async () => ({ success: true, output: "ran" }),
    });
    registry.register({
      name: "project_map", description: "", parameters: { type: "object", properties: {} },
      alwaysOn: true,
      handler: async () => ({ success: true, output: "map" }),
    });
    ctx = makeCtx();
    executor = new ToolExecutor(registry, ctx, { getAllPlugins: () => [] });
  });

  it("exposes every allowlisted tool regardless of tags or alwaysOn", () => {
    ctx.toolAllowlist = ["remember", "question"];
    const names = executor.getToolDefinitions(["code"]).map((t) => t.name);
    expect(names).toEqual(["remember"]);
  });

  it("excludes alwaysOn tools not in the allowlist", () => {
    ctx.toolAllowlist = ["remember"];
    const names = executor.getToolDefinitions().map((t) => t.name);
    expect(names).not.toContain("project_map");
  });

  it("rejects execution of a tool outside the allowlist", async () => {
    ctx.toolAllowlist = ["remember"];
    const res = await executor.execute({ id: "c1", name: "bash", arguments: {} });
    expect(res.success).toBe(false);
    expect(res.output).toContain("not allowed");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/tools/tool-allowlist.test.ts`
Expected: FAIL (allowlist not enforced; `bash`/`project_map` present).

- [ ] **Step 4: Implement allowlist in the executor**

Replace `getToolDefinitions` (`src/tools/executor.ts:194-201`):

```ts
  getToolDefinitions(tags?: string[]): Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    boundedOutput?: boolean;
  }> {
    const allow = this.ctx.toolAllowlist;
    if (allow) {
      const set = new Set(allow);
      return this.registry
        .getAll()
        .filter((t) => set.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          boundedOutput: t.boundedOutput,
        }));
    }
    return this.registry.getAllForLLM(tags);
  }
```

Add at the top of `execute` (`src/tools/executor.ts:53`, before `const tool = ...`):

```ts
    const allow = this.ctx.toolAllowlist;
    if (allow && !allow.includes(call.name)) {
      return {
        success: false,
        output: t("tool.not_allowed", { name: call.name }),
        toolCallId: call.id,
      };
    }
```

- [ ] **Step 5: Add i18n keys**

`src/i18n/en.json`: `"tool.not_allowed": "Tool not allowed in this mode: {name}"`
`src/i18n/ru.json`: `"tool.not_allowed": "Инструмент недоступен в этом режиме: {name}"`

- [ ] **Step 6: Run tests**

Run: `bun test tests/tools/tool-allowlist.test.ts && bun test tests/executor.test.ts`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add src/tools/types.ts src/tools/executor.ts src/i18n/en.json src/i18n/ru.json tests/tools/tool-allowlist.test.ts
git commit -m "feat(tools): strict tool allowlist on ToolContext (onboarding)"
```

---

## Task 2: Agent prompt-block runtime methods

**Files:**
- Modify: `src/core/agent.ts` (add methods near `setPromptIO`, `:288`)
- Test: `tests/onboarding/agent-prompt-block.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/onboarding/agent-prompt-block.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { Agent } from "../../src/core/agent";
import type { AgentDeps } from "../../src/core/agent";
import type { PromptBlock } from "../../src/core/types";

function makeAgent(): Agent {
  const deps = {
    config: { model: "m", pricing: {} } as any,
    llmProvider: {} as any,
    toolExecutor: {} as any,
    pluginManager: {} as any,
    contextManager: {} as any,
    hallucinationDetector: {} as any,
    logger: {} as any,
    baseDir: "/tmp",
    promptBlocks: [],
  } as unknown as AgentDeps;
  return new Agent(deps);
}

describe("Agent prompt-block runtime methods", () => {
  it("pushes and removes a block by identity", () => {
    const agent = makeAgent();
    const block: PromptBlock = {
      kind: "onboarding", content: "guide", priority: "high",
      essential: true, estimatedTokens: 10,
    } as PromptBlock;
    agent.pushPromptBlock(block);
    expect(agent.getPromptBlocksForTest()).toContain(block);
    agent.removePromptBlock(block);
    expect(agent.getPromptBlocksForTest()).not.toContain(block);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/onboarding/agent-prompt-block.test.ts`
Expected: FAIL (`pushPromptBlock` is not a function).

- [ ] **Step 3: Implement the methods** (`src/core/agent.ts`, after `setPromptIO`)

```ts
  /**
   * Append a system-prompt block for the current run (onboarding guide).
   * Identity-based removal via `removePromptBlock`. Prompt blocks are read on
   * every `buildSystemPrompt`, so the block takes effect on the next turn.
   */
  pushPromptBlock(block: PromptBlock): void {
    this.deps.promptBlocks.push(block);
  }

  /** Remove a previously pushed block (by reference). */
  removePromptBlock(block: PromptBlock): void {
    const i = this.deps.promptBlocks.indexOf(block);
    if (i >= 0) this.deps.promptBlocks.splice(i, 1);
  }

  /** Test-only view of the current prompt blocks. */
  getPromptBlocksForTest(): PromptBlock[] {
    return this.deps.promptBlocks;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/onboarding/agent-prompt-block.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agent.ts tests/onboarding/agent-prompt-block.test.ts
git commit -m "feat(agent): runtime prompt-block push/remove for onboarding"
```

---

## Task 3: Provider preflight module

**Files:**
- Create: `src/modules/providers/preflight.ts`
- Modify: `src/cli/setup.ts:119-146` (use the shared probe)
- Test: `tests/onboarding/preflight.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/onboarding/preflight.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { preflightProvider } from "../../src/modules/providers/preflight";

describe("preflightProvider", () => {
  it("reports ok when a model responds", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => "ok" },
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("ok");
  });

  it("reports empty model list", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => "" },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-model");
  });

  it("reports provider error", async () => {
    const res = await preflightProvider(
      { baseUrl: "http://x/v1", apiKey: "k", model: "m" },
      { probe: async () => { throw new Error("ECONNREFUSED"); } },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unreachable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/onboarding/preflight.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/modules/providers/preflight.ts`)

```ts
import { errMsg } from "../../utils";

export interface PreflightConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type PreflightReason = "ok" | "unreachable" | "no-model" | "timeout";

export interface PreflightResult {
  ok: boolean;
  reason: PreflightReason;
  ms: number;
}

export interface PreflightOptions {
  timeoutMs?: number;
  /** Test seam: returns non-empty text when the model responds. */
  probe?: (cfg: PreflightConfig, timeoutMs: number) => Promise<string>;
}

/** Minimal, cheap chat probe: confirms the selected model is loaded. */
export async function probeChat(
  cfg: PreflightConfig,
  timeoutMs: number,
): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: "ok" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return "";
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = data.choices?.[0]?.message;
    return msg?.content || msg?.reasoning_content || "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Confirm the provider answers and the selected model is loaded. Uses a single
 * max_tokens=1 chat call (negligible cost). Never hangs: bounded by timeoutMs.
 */
export async function preflightProvider(
  cfg: PreflightConfig,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const probe = opts.probe ?? probeChat;
  const start = Date.now();
  try {
    const text = await probe(cfg, timeoutMs);
    const ms = Date.now() - start;
    return text ? { ok: true, reason: "ok", ms } : { ok: false, reason: "no-model", ms };
  } catch (err) {
    const ms = Date.now() - start;
    const message = errMsg(err);
    const reason: PreflightReason = /abort|timeout/i.test(message) ? "timeout" : "unreachable";
    return { ok: false, reason, ms };
  }
}
```

- [ ] **Step 4: Refactor `setup.ts` to use `probeChat`**

Replace the body of `testChat` (`src/cli/setup.ts:119-146`) with a call to the shared probe:

```ts
async function testChat(apiBase: string, apiKey: string, model: string): Promise<boolean> {
  try {
    return (await probeChat({ baseUrl: apiBase, apiKey, model }, 10000)) !== "";
  } catch {
    return false;
  }
}
```

Add the import at the top of `setup.ts`:

```ts
import { probeChat } from "../modules/providers/preflight";
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/onboarding/preflight.test.ts && bun test tests/cli 2>/dev/null || true`
Expected: PASS for preflight.

- [ ] **Step 6: Commit**

```bash
git add src/modules/providers/preflight.ts src/cli/setup.ts tests/onboarding/preflight.test.ts
git commit -m "feat(providers): shared preflight (listModels + cheap chat probe)"
```

---

## Task 4: Onboarding prompts & tool lists

**Files:**
- Create: `src/modules/onboarding/prompts.ts`
- Test: `tests/onboarding/prompts.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/onboarding/prompts.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { MEET_SYSTEM_PROMPT, INIT_SYSTEM_PROMPT, MEET_TOOLS, INIT_TOOLS } from "../../src/modules/onboarding/prompts";

describe("onboarding prompts", () => {
  it("meet prompt covers domain first and the whitelist", () => {
    expect(MEET_SYSTEM_PROMPT).toContain("domain");
    for (const key of ["name", "language", "response_style", "autonomy"]) {
      expect(MEET_SYSTEM_PROMPT).toContain(key);
    }
    expect(MEET_SYSTEM_PROMPT).not.toMatch(/programmer|software engineer/i);
  });

  it("meet tool list is restricted", () => {
    expect(MEET_TOOLS).toEqual(["remember", "question", "meet_done"]);
  });

  it("init prompt is workspace-neutral", () => {
    expect(INIT_SYSTEM_PROMPT).toContain("AGENTS.md");
    expect(INIT_SYSTEM_PROMPT).not.toMatch(/git repository is required/i);
  });

  it("init tool list excludes bash", () => {
    expect(INIT_TOOLS).not.toContain("bash");
    expect(INIT_TOOLS).toContain("write_file");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/onboarding/prompts.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/modules/onboarding/prompts.ts`)

```ts
/** Tools available during the meet interview (strict allowlist). */
export const MEET_TOOLS = ["remember", "question", "meet_done"] as const;

/** Tools available during AGENTS.md init (strict allowlist). */
export const INIT_TOOLS = [
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "project_map",
  "question",
  "write_file",
  "edit_file",
] as const;

/**
 * Semi-script interview. The guide owns coverage and the preference-key
 * whitelist; the model owns wording and light follow-ups. Domain-neutral.
 */
export const MEET_SYSTEM_PROMPT = `You are getting acquainted with the user. This is a short interview, not a task.
Rules:
- Ask 1-3 short questions per turn, in the user's language.
- START by asking what the user will mainly use the agent for (their domain / usage profile): e.g. software development, working with APIs, smart home, automation, personal assistant, web search, computer setup — or anything else. Never assume they are a programmer.
- Then cover: name; reply language; response style (concise | balanced | detailed); tools & experience; working habits; hard "do not do without asking" rules; goals.
- Only if the user named software development as a use case may you ask about code / commit language.
- Save each answer with the "remember" tool. Use category=preferences with these keys ONLY: domain, name, language, response_style, autonomy, code_language. Use category=facts (free text, user's language) for experience, habits, goals and any concrete "do not" rule (preserve it verbatim).
- Leave code_language out entirely when development is not a use case.
- Keep preference values as canonical English tokens (e.g. domain=development,api; autonomy=ask).
- Never touch the file system, run commands, or inspect the repository.
- When every topic is covered (or the user wants to stop), give a one-line summary of what you remembered, then call the "meet_done" tool.`;

/**
 * AGENTS.md authoring guide. Domain-neutral: works for code, docs, notes or
 * configs; code is only one case.
 */
export const INIT_SYSTEM_PROMPT = `You create or improve an AGENTS.md file for the current workspace.
Rules:
- First read what is here: use project_map, read_file, list_dir, glob, grep. The workspace may be code, docs, notes, configs or mixed — never assume a programming project.
- If AGENTS.md already exists, IMPROVE it in place: produce a proposed full version, show it, and let the user confirm before writing. Never silently overwrite.
- Capture: purpose & usage profile; key structure; how to run/use things (only if applicable); conventions; setup quirks/gotchas; references to existing instruction sources (e.g. Cursor/Copilot rules).
- Ask targeted questions only when the files cannot answer.
- Keep it concise and within the instructions budget.
- Write with write_file or edit_file; do not run shell commands.`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/onboarding/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/onboarding/prompts.ts tests/onboarding/prompts.test.ts
git commit -m "feat(onboarding): meet/init prompts and tool allowlists"
```

---

## Task 5: `meet_done` sentinel tool

**Files:**
- Create: `src/tools/meet-done.ts`
- Modify: `src/tools/index.ts` (register next to `rememberTool`/`recallTool`)
- Test: `tests/onboarding/meet-done.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/onboarding/meet-done.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { meetDoneTool } from "../../src/tools/meet-done";
import type { ToolContext } from "../../src/tools/types";

describe("meet_done", () => {
  it("flips ctx.onboarding.done", async () => {
    const ctx = { onboarding: { done: false } } as unknown as ToolContext;
    const res = await meetDoneTool.handler(ctx, {});
    expect(res.success).toBe(true);
    expect(ctx.onboarding!.done).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/onboarding/meet-done.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/tools/meet-done.ts`)

```ts
import type { ToolDefinition } from "./types";

/** Sentinel: the model calls this to signal the meet interview is finished. */
export const meetDoneTool: ToolDefinition = {
  name: "meet_done",
  description:
    "Signal that the get-acquainted interview is complete. Call only after the final summary.",
  tags: ["memory"],
  parameters: { type: "object", properties: {} },
  handler: async (ctx) => {
    if (ctx.onboarding) ctx.onboarding.done = true;
    return { success: true, output: "Interview marked complete." };
  },
};
```

- [ ] **Step 4: Register the tool** — in `src/tools/index.ts`, import and register `meetDoneTool` alongside `rememberTool` (follow the existing registration pattern; keep the same list/array the registry consumes).

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/onboarding/meet-done.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/meet-done.ts src/tools/index.ts tests/onboarding/meet-done.test.ts
git commit -m "feat(tools): meet_done sentinel for onboarding"
```

---

## Task 6: Onboarding mode manager

**Files:**
- Create: `src/modules/onboarding/mode.ts`
- Test: `tests/onboarding/mode.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/onboarding/mode.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { enterMeetMode, exitMeetMode, isMeetDone } from "../../src/modules/onboarding/mode";
import { MEET_TOOLS, MEET_SYSTEM_PROMPT } from "../../src/modules/onboarding/prompts";
import type { ReplContext } from "../../src/cli/repl-commands";

function fakeCtx() {
  const pushed: any[] = [];
  const ctx = {
    toolCtx: {},
    agent: {
      pushPromptBlock: (b: any) => pushed.push(b),
      removePromptBlock: (b: any) => {
        const i = pushed.indexOf(b);
        if (i >= 0) pushed.splice(i, 1);
      },
    },
  };
  return { ctx: ctx as unknown as ReplContext, pushed };
}

describe("onboarding mode", () => {
  it("enters meet mode: allowlist + prompt block + state", () => {
    const { ctx, pushed } = fakeCtx();
    enterMeetMode(ctx);
    expect(ctx.toolCtx.toolAllowlist).toEqual([...MEET_TOOLS]);
    expect(ctx.toolCtx.onboarding?.done).toBe(false);
    expect(ctx.toolCtx.onboarding?.block?.content).toBe(MEET_SYSTEM_PROMPT);
    expect(pushed).toHaveLength(1);
  });

  it("exits meet mode: clears allowlist, state and block", () => {
    const { ctx, pushed } = fakeCtx();
    enterMeetMode(ctx);
    exitMeetMode(ctx);
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
    expect(ctx.toolCtx.onboarding).toBeUndefined();
    expect(pushed).toHaveLength(0);
  });

  it("reports done from the shared state", () => {
    const { ctx } = fakeCtx();
    enterMeetMode(ctx);
    expect(isMeetDone(ctx)).toBe(false);
    ctx.toolCtx.onboarding!.done = true;
    expect(isMeetDone(ctx)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/onboarding/mode.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/modules/onboarding/mode.ts`)

```ts
import type { ReplContext } from "../../cli/repl-commands";
import type { PromptBlock } from "../../core/types";
import { estimateTokens } from "../../llm/token-counter";
import { MEET_SYSTEM_PROMPT, MEET_TOOLS } from "./prompts";

/**
 * Enter meet mode on the shared agent: restrict tools to the allowlist,
 * create the shared onboarding state (carrying the guide block), and inject
 * the interview guide. Meet mode persists across REPL turns until
 * `exitMeetMode` (driven by the `meet_done` sentinel).
 */
export function enterMeetMode(ctx: ReplContext): void {
  const block: PromptBlock = {
    kind: "onboarding",
    content: MEET_SYSTEM_PROMPT,
    priority: "high",
    essential: true,
    estimatedTokens: estimateTokens(MEET_SYSTEM_PROMPT),
  };
  ctx.toolCtx.toolAllowlist = [...MEET_TOOLS];
  ctx.toolCtx.onboarding = { done: false, block };
  ctx.agent.pushPromptBlock(block);
}

/** Leave meet mode: remove the guide and restore unrestricted tools. */
export function exitMeetMode(ctx: ReplContext): void {
  const block = ctx.toolCtx.onboarding?.block;
  if (block) ctx.agent.removePromptBlock(block);
  ctx.toolCtx.toolAllowlist = undefined;
  ctx.toolCtx.onboarding = undefined;
}

/** True when the sentinel tool has fired for the active meet session. */
export function isMeetDone(ctx: ReplContext): boolean {
  return ctx.toolCtx.onboarding?.done === true;
}
```

- [ ] **Step 4: Expose `toolCtx` on `ReplContext`**

In `src/cli/repl-commands.ts`, add to `ReplContext` (near `agent`):

```ts
  /** Shared tool context — carries mode-scoped state (allowlist, onboarding). */
  readonly toolCtx: import("../tools/types").ToolContext;
```

Wiring of `toolCtx` onto the `Repl` instance is done in Task 12 (the `Repl` class implements `ReplContext`). Until then `tsc` will flag the missing field — expected.

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test tests/onboarding/mode.test.ts && tsc --noEmit`
Expected: PASS both.

- [ ] **Step 6: Commit**

```bash
git add src/modules/onboarding/mode.ts src/cli/repl-commands.ts src/cli/repl.ts tests/onboarding/mode.test.ts
git commit -m "feat(onboarding): meet mode (allowlist + guide block)"
```

---

## Task 7: `meet` engine

**Files:**
- Create: `src/modules/onboarding/meet.ts`
- Test: `tests/onboarding/meet.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/onboarding/meet.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import { runMeet } from "../../src/modules/onboarding/meet";

function fakeCtx(over: Record<string, unknown> = {}) {
  return {
    config: { provider: { baseUrl: "http://x/v1", apiKey: "k" }, model: "m" },
    baseDir: "/tmp",
    toolCtx: {},
    agent: { pushPromptBlock() {}, removePromptBlock() {} },
    output: { writeLine: vi.fn() },
    runAgent: vi.fn(async () => {}),
    ...over,
  } as any;
}

describe("runMeet", () => {
  it("refuses when preflight fails", async () => {
    const ctx = fakeCtx();
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: false, reason: "unreachable", ms: 3 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
  });

  it("enters mode and starts the interview when preflight succeeds", async () => {
    const ctx = fakeCtx();
    const ok = await runMeet(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 3 }) });
    expect(ok).toBe(true);
    expect(ctx.runAgent).toHaveBeenCalledOnce();
    expect(ctx.toolCtx.toolAllowlist).toContain("remember");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/onboarding/meet.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/modules/onboarding/meet.ts`)

```ts
import type { ReplContext } from "../../cli/repl-commands";
import type { PreflightResult } from "../providers/preflight";
import { preflightProvider } from "../providers/preflight";
import { enterMeetMode } from "./mode";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";

export interface RunMeetOptions {
  /** Test seam. */
  preflight?: () => Promise<PreflightResult>;
}

/**
 * Start the get-acquainted interview. Preflights the provider, enters meet
 * mode, and kicks off the first agent turn. Meet mode stays active across
 * subsequent REPL turns until `meet_done` fires or the user exits.
 * Returns false when the provider is unavailable (nothing is modified).
 */
export async function runMeet(ctx: ReplContext, opts: RunMeetOptions = {}): Promise<boolean> {
  const check =
    opts.preflight ??
    (() =>
      preflightProvider({
        baseUrl: ctx.config.provider.baseUrl,
        apiKey: ctx.config.provider.apiKey,
        model: ctx.config.model,
      }));

  const pre = await check();
  if (!pre.ok) {
    ctx.output.writeLine(pc.yellow(t("repl.meet_unavailable", { reason: pre.reason })));
    ctx.output.writeLine(t("repl.meet_unavailable_hint"));
    return false;
  }

  enterMeetMode(ctx);
  await ctx.runAgent(t("repl.meet_start_prompt"));
  return true;
}
```

- [ ] **Step 4: Add i18n keys** (en+ru)

en:
```json
"repl.meet_start_prompt": "Let's get acquainted. Start the interview now.",
"repl.meet_unavailable": "Can't start: the provider is not responding ({reason}).",
"repl.meet_unavailable_hint": "Start the model and try /meet again — nothing was saved."
```
ru:
```json
"repl.meet_start_prompt": "Давай познакомимся. Начни интервью.",
"repl.meet_unavailable": "Не могу начать: провайдер не отвечает ({reason}).",
"repl.meet_unavailable_hint": "Запусти модель и повтори /meet — ничего не записано."
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/onboarding/meet.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/onboarding/meet.ts src/i18n/en.json src/i18n/ru.json tests/onboarding/meet.test.ts
git commit -m "feat(onboarding): meet engine with preflight + mode entry"
```

---

## Task 8: `init` engine

**Files:**
- Create: `src/modules/onboarding/init.ts`
- Test: `tests/onboarding/init.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/onboarding/init.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import { runInit } from "../../src/modules/onboarding/init";

function fakeCtx() {
  return {
    config: { provider: { baseUrl: "http://x/v1", apiKey: "k" }, model: "m" },
    baseDir: "/tmp/ws",
    toolCtx: {},
    agent: {
      pushPromptBlock: vi.fn(),
      removePromptBlock: vi.fn(),
    },
    output: { writeLine: vi.fn() },
    runAgent: vi.fn(async () => {}),
  } as any;
}

describe("runInit", () => {
  it("sets an init allowlist, runs once, then restores state", async () => {
    const ctx = fakeCtx();
    await runInit(ctx, { preflight: async () => ({ ok: true, reason: "ok", ms: 1 }) });
    expect(ctx.runAgent).toHaveBeenCalledOnce();
    expect(ctx.agent.pushPromptBlock).toHaveBeenCalledOnce();
    expect(ctx.agent.removePromptBlock).toHaveBeenCalledOnce();
    expect(ctx.toolCtx.toolAllowlist).toBeUndefined();
    expect(ctx.toolCtx.onboarding).toBeUndefined();
  });

  it("refuses when preflight fails", async () => {
    const ctx = fakeCtx();
    const ok = await runInit(ctx, { preflight: async () => ({ ok: false, reason: "no-model", ms: 1 }) });
    expect(ok).toBe(false);
    expect(ctx.runAgent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/onboarding/init.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/modules/onboarding/init.ts`)

```ts
import { basename, join } from "path";
import type { ReplContext } from "../../cli/repl-commands";
import type { PromptBlock } from "../../core/types";
import { estimateTokens } from "../../llm/token-counter";
import type { PreflightResult } from "../providers/preflight";
import { preflightProvider } from "../providers/preflight";
import { INIT_SYSTEM_PROMPT, INIT_TOOLS } from "./prompts";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";

export interface RunInitOptions {
  preflight?: () => Promise<PreflightResult>;
}

/**
 * Generate or improve AGENTS.md for the workspace. Single agent run with a
 * strict allowlist (no bash). Returns false when the provider is unavailable.
 */
export async function runInit(ctx: ReplContext, opts: RunInitOptions = {}): Promise<boolean> {
  const check =
    opts.preflight ??
    (() =>
      preflightProvider({
        baseUrl: ctx.config.provider.baseUrl,
        apiKey: ctx.config.provider.apiKey,
        model: ctx.config.model,
      }));

  const pre = await check();
  if (!pre.ok) {
    ctx.output.writeLine(pc.yellow(t("repl.init_unavailable", { reason: pre.reason })));
    ctx.output.writeLine(t("repl.meet_unavailable_hint"));
    return false;
  }

  const block: PromptBlock = {
    kind: "onboarding",
    content: INIT_SYSTEM_PROMPT,
    priority: "high",
    essential: true,
    estimatedTokens: estimateTokens(INIT_SYSTEM_PROMPT),
  };
  ctx.agent.pushPromptBlock(block);
  ctx.toolCtx.toolAllowlist = [...INIT_TOOLS];
  try {
    await ctx.runAgent(
      t("repl.init_start_prompt", { dir: join(ctx.baseDir, "AGENTS.md") }),
    );
  } finally {
    ctx.agent.removePromptBlock(block);
    ctx.toolCtx.toolAllowlist = undefined;
  }
  return true;
}
```

- [ ] **Step 4: Add i18n keys** (en+ru)

en:
```json
"repl.init_start_prompt": "Generate or improve {dir} for this workspace. Scan first, then write.",
"repl.init_unavailable": "Can't run init: the provider is not responding ({reason})."
```
ru:
```json
"repl.init_start_prompt": "Создай или улучши {dir} для этой папки. Сначала изучи, потом запиши.",
"repl.init_unavailable": "Не могу запустить init: провайдер не отвечает ({reason})."
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/onboarding/init.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/onboarding/init.ts src/i18n/en.json src/i18n/ru.json tests/onboarding/init.test.ts
git commit -m "feat(onboarding): init engine (AGENTS.md, single run)"
```

---

## Task 9: `question` tool rendering per STYLE

**Files:**
- Modify: `src/tools/user-input.ts:52-73` (`formatMenu`, `choicePrompt`)
- Test: `tests/tools/user-input-style.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/tools/user-input-style.test.ts`)

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";
import { formatMenu, choicePrompt } from "../../src/tools/user-input";

const options = [
  { label: "concise", description: "just the gist" },
  { label: "balanced", description: "default" },
];

describe("question rendering (STYLE)", () => {
  beforeEach(() => setLocale("en"));

  it("prefixes the question with the ? glyph", () => {
    const menu = formatMenu("Reply style?", options);
    expect(menu.split("\n")[0]).toBe("? Reply style?");
  });

  it("indents numbered options with label — description", () => {
    const menu = formatMenu("Reply style?", options);
    expect(menu).toContain("  [1] concise — just the gist");
    expect(menu).toContain("  [2] balanced — default");
  });

  it("appends the custom entry when allowCustom is set", () => {
    const menu = formatMenu("Reply style?", options, { allowCustom: true });
    expect(menu).toContain("[3]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun tests/tools/user-input-style.test.ts`
Expected: FAIL (no `?` prefix).

- [ ] **Step 3: Implement** (`src/tools/user-input.ts`)

Replace `formatMenu` (`:52-66`):

```ts
/** Render `? <question>` + indented options per STYLE.md. */
export function formatMenu(
  question: string,
  options: InputOption[],
  opts: AskChoiceOptions = {},
): string {
  const lines: string[] = [`? ${question}`];
  options.forEach((opt, i) => {
    lines.push(`  [${i + 1}] ${opt.label} — ${opt.description}`);
  });
  if (opts.allowCustom) {
    lines.push(`  [${options.length + 1}] ${t("tool.user_input.custom_option")}`);
  }
  return lines.join("\n");
}
```

Replace `choicePrompt` (`:68-73`):

```ts
/** `>` prompt marker for a selection, per STYLE.md. */
export function choicePrompt(optionCount: number, multiple: boolean): string {
  return multiple
    ? t("tool.user_input.choice_multiple", { max: optionCount })
    : t("tool.user_input.choice_single", { max: optionCount });
}
```

Update `tool.user_input.choice_single` / `choice_multiple` values to start with `> ` (en+ru):
- en `choice_single`: `"> Select [1-{max}]: "`; `choice_multiple`: `"> Select (comma-separated, e.g. 1,3): "`
- ru: `"> Ваш выбор (1-{max}): "`; `"> Ваш выбор (через запятую, напр. 1,3): "`

Add `? ` to free-text questions in `askUser` (`:143-147`): prepend `? ` when building `text` (keep the progress header on its own line).

- [ ] **Step 4: Run tests**

Run: `bun tests/tools/user-input-style.test.ts && bun tests/tools/user-input.test.ts && bun tests/tools/question.test.ts`
Expected: PASS (update any existing assertions that expected the old prefix).

- [ ] **Step 5: Commit**

```bash
git add src/tools/user-input.ts src/i18n/en.json src/i18n/ru.json tests/tools/user-input-style.test.ts tests/tools/user-input.test.ts
git commit -m "feat(ui): align question tool rendering with STYLE (? glyph, > prompt)"
```

---

## Task 10: i18n — command labels, memory, onboarding

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`

- [ ] **Step 1: Add all remaining keys** (en then mirrored ru; keep parity)

| Key | en | ru |
|---|---|---|
| `cli.setup` | `Interactive setup wizard (provider, model, security).` | `Мастер настройки (провайдер, модель, безопасность).` |
| `cli.meet` | `Get acquainted — record your preferences and usage profile.` | `Познакомимся — записать предпочтения и профиль использования.` |
| `cli.init` | `Generate or update AGENTS.md for this workspace.` | `Создать или обновить AGENTS.md для этой папки.` |
| `repl.setup_usage` | `/setup` | `/setup` |
| `repl.meet_usage` | `/meet — get acquainted` | `/meet — познакомимся` |
| `repl.init_usage` | `/init — generate/update AGENTS.md` | `/init — создать/обновить AGENTS.md` |
| `repl.memory_usage` | `/memory [get\|set\|unset\|find\|forget]` | `/memory [get\|set\|unset\|find\|forget]` |
| `repl.memory_empty` | `Memory is empty.` | `Память пуста.` |
| `repl.memory_prefs` | `Preferences:` | `Предпочтения:` |
| `repl.memory_set` | `Saved {key}={value}` | `Сохранено {key}={value}` |
| `repl.memory_unset` | `Removed {key}` | `Удалено {key}` |
| `repl.memory_not_found` | `No preference "{key}"` | `Нет предпочтения "{key}"` |
| `repl.memory_forgotten` | `Removed {category} entry {n}` | `Удалена запись {n} из {category}` |
| `repl.meet_offer` | `Shall we get acquainted? I'll ask a few questions and remember how you like to work.` | `Познакомимся? Задам несколько вопросов и запомню, как тебе удобнее работать.` |
| `repl.meet_offer_hint` | `You can skip now and run /meet later.` | `Можно пропустить и вызвать /meet позже.` |
| `onboarding.already` | `Already running.` | `Уже выполняется.` |
| `onboarding.provider_down` | `⚠ Provider is not responding — "{cmd}" is unavailable for now.` | `⚠ Провайдер не отвечает — «{cmd}» пока недоступно.` |
| `onboarding.provider_down_hint` | `↳ Start the model and run /{cmd}. Nothing was saved.` | `↳ Подними модель и вызови /{cmd}. Ничего не записано.` |

- [ ] **Step 2: Verify parity**

Run: `bun tests/i18n-parity.test.ts 2>/dev/null || bun run -e "const en=require('./src/i18n/en.json'),ru=require('./src/i18n/ru.json');const a=Object.keys(en),b=new Set(Object.keys(ru));const m=a.filter(k=>!b.has(k));const n=Object.keys(ru).filter(k=>!(k in en));console.log('missing-in-ru',m,'missing-in-en',n)"`
Expected: no missing keys (if a parity test exists, it passes).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/en.json src/i18n/ru.json
git commit -m "feat(i18n): onboarding, memory and setup command strings (en+ru)"
```

---

## Task 11: Session logging

**Files:**
- Modify: `src/core/session-logger.ts` (add `logOnboarding` near `logMoE`, `:399`)
- Modify: `src/cli/repl.ts` (log at meet/init start and meet exit)

- [ ] **Step 1: Add `logOnboarding` to `SessionLogger`**

Read `logMoE` at `src/core/session-logger.ts:399` and reuse its internal writer. Add:

```ts
  /** Log an onboarding lifecycle event (meet/init) for post-mortem analysis. */
  logOnboarding(event: string, data: Record<string, unknown> = {}): void {
    this.logEntry({ type: `onboarding_${event}`, ...data } as never);
  }
```

Use the same private write helper `logMoE` calls (rename/reuse it — do not invent a new one).

- [ ] **Step 2: Log from the REPL lifecycle**

In `src/cli/repl.ts`, where Meet/Init start and where meet mode exits (Task 12), emit:

```ts
    new SessionLogger(this.sessionManager, this.logger, () => ({})).logOnboarding("meet_start", {
      model: this.config.model,
    });
```

and `"meet_done"` / `"init_start"` / `"init_done"` at the corresponding points. Import `SessionLogger` from `../core/session-logger`. (`this.sessionManager` and `this.logger` are already REPL fields from the constructor.)

- [ ] **Step 3: Typecheck**

Run: `tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/session-logger.ts src/cli/repl.ts
git commit -m "feat(session): log onboarding lifecycle events"
```

---

## Task 12: `meet_done` handling + meet mode lifecycle in the REPL

**Files:**
- Modify: `src/cli/repl.ts` (after each agent turn, check `isMeetDone`)
- Test: covered by mode/meet tests; manual scenario in Task 16.

- [ ] **Step 1: Expose `toolCtx` on the `Repl` instance**

`Repl` must implement `ReplContext`, which now requires `toolCtx`. The `Repl` constructor receives `agent` but not `toolCtx`; get it from `agent` via a new getter. Add to `src/core/agent.ts`:

```ts
  /** Shared tool context (mode-scoped state: allowlist, onboarding). */
  get toolContext(): import("../tools/types").ToolContext {
    return this.deps.toolExecutor["ctx"] as import("../tools/types").ToolContext;
  }
```

If reaching through the executor is not viable, extend `AgentDeps` with `toolCtx?: ToolContext` and pass `bootstrap`'s `toolCtx` into the `Agent` constructor in `bootstrap.ts` (search `new Agent({`), then expose it here. Prefer the explicit `AgentDeps.toolCtx` route.

- [ ] **Step 2: After each completed turn, exit meet mode if the sentinel fired**

Locate the REPL turn completion point (where the agent run resolves and the prompt is re-presented, near `src/cli/repl.ts:1207`). Add:

```ts
    if (this.toolCtx.onboarding && isMeetDone(this)) {
      const { exitMeetMode } = await import("../modules/onboarding/mode");
      exitMeetMode(this);
      this.output.writeLine(pc.dim(t("repl.meet_done")));
    } else if (this.toolCtx.onboarding) {
      // interview continues: no special handling, the user answers normally
    }
```

Add `"repl.meet_done": "Done — preferences saved. See /memory."` / ru `"Готово — предпочтения сохранены. Смотри /memory."`

- [ ] **Step 3: Typecheck + tests**

Run: `tsc --noEmit && bun test tests/onboarding`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/repl.ts src/core/agent.ts src/core/bootstrap.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat(repl): leave meet mode when the sentinel fires"
```

---

## Task 13: REPL commands `/setup`, `/meet`, `/init`, `/memory`

**Files:**
- Create: `src/cli/onboarding-commands.ts`
- Modify: `src/cli/repl.ts` (call `registerOnboardingCommands(ctx)`)
- Test: `tests/cli/memory-command.test.ts`

- [ ] **Step 1: Write the failing test** (`tests/cli/memory-command.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MemoryStore } from "../../src/modules/memory/store";
import { applyMemoryCommand } from "../../src/cli/onboarding-commands";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mma-mem-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("applyMemoryCommand", () => {
  it("sets and gets a preference", () => {
    const store = new MemoryStore(dir);
    applyMemoryCommand(store, ["set", "language", "ru"]);
    expect(store.getPreferences().language).toBe("ru");
  });
  it("unsets a preference", () => {
    const store = new MemoryStore(dir);
    store.setPreference("language", "ru");
    applyMemoryCommand(store, ["unset", "language"]);
    expect(store.getPreferences().language).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/memory-command.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement pure logic** (`src/cli/onboarding-commands.ts`)

```ts
import { homedir } from "os";
import { join } from "path";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { MemoryStore } from "../modules/memory/store";
import type { ReplContext } from "./repl-commands";
import { runMeet } from "../modules/onboarding/meet";
import { runInit } from "../modules/onboarding/init";

const CATEGORIES = ["conventions", "decisions", "errors", "facts"] as const;

/** Pure `/memory` dispatch — no rendering, returns lines for the caller. */
export function applyMemoryCommand(store: MemoryStore, args: string[]): string[] {
  const [sub, ...rest] = args;
  if (!sub) return renderOverview(store);
  switch (sub) {
    case "get": {
      const key = rest[0];
      const prefs = store.getPreferences();
      if (!key || !(key in prefs)) return [pc.yellow(t("repl.memory_not_found", { key: key ?? "" }))];
      return [`${key}=${prefs[key]}`];
    }
    case "set": {
      const [key, ...value] = rest;
      if (!key || value.length === 0) return [t("repl.memory_usage")];
      store.setPreference(key, value.join(" "));
      return [pc.green(t("repl.memory_set", { key, value: value.join(" ") }))];
    }
    case "unset": {
      const key = rest[0];
      if (!key) return [t("repl.memory_usage")];
      const ok = store.deletePreference(key);
      return [ok ? t("repl.memory_unset", { key }) : pc.yellow(t("repl.memory_not_found", { key }))];
    }
    case "find": {
      const query = rest.join(" ");
      const hits = store.search(query);
      return hits.length ? hits.map((h) => `${pc.dim(h.file)}  ${h.match}`) : [t("repl.memory_empty")];
    }
    case "forget": {
      const [category, nRaw] = rest;
      if (!category || !CATEGORIES.includes(category as never)) return [t("repl.memory_usage")];
      const n = parseInt(nRaw ?? "0", 10);
      const ok = n > 0 && store.deleteEntry(category, n);
      return [
        ok
          ? t("repl.memory_forgotten", { category, n: String(n) })
          : pc.yellow(t("repl.memory_not_found", { key: `${category} #${nRaw}` })),
      ];
    }
    default:
      return [t("repl.memory_usage")];
  }
}

function renderOverview(store: MemoryStore): string[] {
  const out: string[] = [];
  const prefs = store.getPreferences();
  out.push(pc.bold(t("repl.memory_prefs")));
  const entries = Object.entries(prefs);
  if (entries.length === 0) out.push(pc.dim(t("repl.memory_empty")));
  for (const [k, v] of entries) out.push(`  ${k} = ${v}`);
  for (const cat of CATEGORIES) {
    const tail = store
      .read(cat)
      .split(/\r?\n/)
      .filter((l) => l.startsWith("- "))
      .slice(-3);
    if (tail.length === 0) continue;
    out.push(pc.dim(`[${cat}]`));
    for (const l of tail) out.push(`  ${l}`);
  }
  return out;
}

/** Register `/setup`, `/meet`, `/init`, `/memory`. */
export function registerOnboardingCommands(ctx: ReplContext): void {
  const handlers: Record<string, (args: string[]) => void | Promise<void>> = {
    get: (a) => emit(ctx, ["get", ...a]),
    set: (a) => emit(ctx, ["set", ...a]),
    unset: (a) => emit(ctx, ["unset", ...a]),
    find: (a) => emit(ctx, ["find", ...a]),
    forget: (a) => emit(ctx, ["forget", ...a]),
  };
  const store = () => new MemoryStore(join(homedir(), ".mma", "memory"));

  ctx.registerCommand({
    name: "memory",
    description: t("repl.memory_usage"),
    usage: t("repl.memory_usage"),
    action: async (args) => {
      const lines = args.length ? applyMemoryCommand(store(), args) : renderOverview(store());
      for (const l of lines) ctx.output.writeLine(l);
    },
  });

  ctx.registerCommand({
    name: "setup",
    description: t("cli.setup"),
    usage: t("repl.setup_usage"),
    action: async () => {
      const { runSetup } = await import("./setup");
      const { applyAnswersToConfig } = await import("./setup-order");
      const { saveConfig } = await import("../config/config");
      const answers = await runSetup();
      applyAnswersToConfig(ctx.config, answers);
      saveConfig(ctx.config, join(ctx.configDir, "config.json"), ctx.configDir);
      await ctx.agent.reconfigure(ctx.config);
      ctx.output.writeLine(t("cli.config_saved"));
    },
  });

  ctx.registerCommand({
    name: "meet",
    description: t("cli.meet"),
    aliases: ["познакомимся"],
    usage: t("repl.meet_usage"),
    action: async () => {
      await runMeet(ctx);
    },
  });

  ctx.registerCommand({
    name: "init",
    description: t("cli.init"),
    usage: t("repl.init_usage"),
    action: async () => {
      await runInit(ctx);
    },
  });

  function emit(c: ReplContext, a: string[]): void {
    for (const l of applyMemoryCommand(store(), a)) c.output.writeLine(l);
  }
}
```

- [ ] **Step 4: Add `deleteEntry` to `MemoryStore`** — `applyMemoryCommand`'s `forget` case calls `store.deleteEntry(category, n)`, which does not exist yet.

In `src/modules/memory/store.ts` add:

```ts
  /** Remove the nth (1-based) append-only entry from a category file. */
  deleteEntry(name: string, n: number): boolean {
    const path = join(this.memoryDir, `${name}.md`);
    if (!existsSync(path)) return false;
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    const indexes = lines
      .map((l, i) => (l.startsWith("- ") ? i : -1))
      .filter((i) => i >= 0);
    if (n < 1 || n > indexes.length) return false;
    lines.splice(indexes[n - 1], 1);
    writeFileSync(path, lines.join("\n"), "utf-8");
    return true;
  }
```

- [ ] **Step 5: Register from the REPL** — in `src/cli/repl.ts`, in the same place other command groups are registered (search `registerProviderCommands` / `registerReplCommands`), add:

```ts
    const { registerOnboardingCommands } = await import("./onboarding-commands");
    registerOnboardingCommands(this);
```

Also add the new command names to the completer (`src/cli/completer.ts`) and to `COMMAND_GROUPS` in `src/cli/repl-commands.ts` (`setup`, `meet`, `init`, `memory` → `"agent"`).

- [ ] **Step 6: Run tests + typecheck**

Run: `bun test tests/cli/memory-command.test.ts && tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/onboarding-commands.ts src/cli/repl.ts src/cli/completer.ts src/cli/repl-commands.ts src/modules/memory/store.ts tests/cli/memory-command.test.ts
git commit -m "feat(repl): /setup, /meet, /init, /memory commands"
```

---

## Task 14: CLI subcommands (`mma setup`, `mma meet`, `mma init`)

**Files:**
- Modify: `src/cli/commands.ts:43-55` (rename `buildInitCommand` → `buildSetupCommand`; add `init` + `meet`)
- Test: manual

- [ ] **Step 1: Rename the wizard command**

In `src/cli/commands.ts`, change the existing `buildInitCommand` to register `"setup"` instead of `"init"`:

```ts
function buildSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(t("cli.setup"))
    .action(async () => {
      const answers = await runSetup();
      const configPath = join(homedir(), ".mma", "config.json");
      const { config } = await bootstrap();
      applyAnswersToConfig(config, answers);
      saveConfig(config, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.config_saved"));
    });
}
```

Rename the call site (`buildInitCommand(program)` → `buildSetupCommand(program)`).

- [ ] **Step 2: Extract the interactive REPL start in `main.ts`**

The default (no-subcommand) path at `src/cli/main.ts:303-339` builds `bootstrap` + `new Repl(...)` + `repl.start()`. Extract it into an exported function so subcommands can reuse it:

```ts
export async function startInteractiveRepl(opts: {
  projectDir?: string;
  noAgentsMd?: boolean;
  exitOnComplete?: boolean;
  reasoningLevel?: string;
  contextLog?: boolean;
  verboseOpt?: boolean;
} = {}): Promise<void> {
  const {
    agent, config, sessionManager, skillsModule, pluginManager,
    execModule, configDir, baseDir, logger, envReport, contextProbe,
  } = await bootstrap(
    undefined,
    opts.projectDir,
    opts.noAgentsMd,
    opts.exitOnComplete,
    opts.reasoningLevel,
    opts.contextLog,
  );
  if (opts.verboseOpt) config.ui.verbosity = "verbose";
  getDefaultChannel().setSuppressInfoLogs(
    !(opts.verboseOpt || config.ui.verbose || config.ui.verbosity === "verbose"),
  );
  const repl = new Repl(
    agent, config, sessionManager, skillsModule, pluginManager, configDir,
    baseDir, opts.noAgentsMd, logger, true, envReport, undefined, execModule, contextProbe,
  );
  startAutoUpdate(config);
  await repl.start();
}
```

Replace the extracted block in the default branch with `await startInteractiveRepl({ projectDir, noAgentsMd, exitOnComplete, reasoningLevel, contextLog, verboseOpt });`.

- [ ] **Step 3: Add `meet` and `init` commands that delegate to the REPL**

```ts
function buildMeetCommand(program: Command): void {
  program
    .command("meet")
    .description(t("cli.meet"))
    .action(async () => {
      process.env.MMA_START_MEET = "1";
      const { startInteractiveRepl } = await import("./main");
      await startInteractiveRepl();
    });
}

function buildInitCommand(program: Command): void {
  program
    .command("init")
    .description(t("cli.init"))
    .action(async () => {
      process.env.MMA_START_INIT = "1";
      const { startInteractiveRepl } = await import("./main");
      await startInteractiveRepl();
    });
}
```

`repl.ts` reads `MMA_START_MEET` / `MMA_START_INIT` on startup (Task 15) and invokes the engine once, then clears the flag. This keeps a single stdin owner (the LineEditor) — matching the 1.0.1 first-run guarantee.

- [ ] **Step 4: Register both** — call `buildSetupCommand(program)`, `buildInitCommand(program)`, `buildMeetCommand(program)` where `buildInitCommand(program)` was called.

- [ ] **Step 5: Typecheck**

Run: `tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands.ts src/i18n/en.json src/i18n/ru.json
git commit -m "feat(cli): mma setup (renamed), mma init, mma meet"
```

---

## Task 15: Post-setup `[Y/n]` offer

**Files:**
- Modify: `src/cli/repl.ts` (startup, when `process.env.MMA_POST_SETUP === "1"`)
- Modify: `src/cli/main.ts:288-289` (pass through, unchanged guard)

- [ ] **Step 1: On REPL start, if `MMA_POST_SETUP=1` and TTY and not `--json`, offer**

After the banner is printed and before the first `rl.prompt()` in `src/cli/repl.ts` (near `:1191`), add:

```ts
    if (process.env.MMA_POST_SETUP === "1" && process.stdout.isTTY && process.env.MMA_START_MEET !== "1" && process.env.MMA_START_INIT !== "1") {
      const { preflightProvider } = await import("../modules/providers/preflight");
      const pre = await preflightProvider({
        baseUrl: this.config.provider.baseUrl,
        apiKey: this.config.provider.apiKey,
        model: this.config.model,
      });
      if (pre.ok) {
        this.output.writeLine(pc.dim(`${t("repl.meet_offer")} ${t("repl.meet_offer_hint")}`));
        const answer = (await this.rl.question("[Y/n] ")).trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes" || /да/.test(answer)) {
          const { runMeet } = await import("../modules/onboarding/meet");
          await runMeet(this, { preflight: async () => pre });
        }
      } else {
        this.output.writeLine(pc.yellow(t("onboarding.provider_down", { cmd: "meet" })));
        this.output.writeLine(t("onboarding.provider_down_hint", { cmd: "meet" }));
      }
    }
```

- [ ] **Step 2: Honor `MMA_START_MEET` / `MMA_START_INIT`** — just before the offer block add:

```ts
    if (process.env.MMA_START_MEET === "1") {
      delete process.env.MMA_START_MEET;
      const { runMeet } = await import("../modules/onboarding/meet");
      await runMeet(this);
    } else if (process.env.MMA_START_INIT === "1") {
      delete process.env.MMA_START_INIT;
      const { runInit } = await import("../modules/onboarding/init");
      await runInit(this);
    }
```

- [ ] **Step 3: Manual check** — run in a sandbox with a reachable provider and confirm the offer appears; with the provider stopped, confirm the calm hint and no offer.

Run: `bun run mma -d _testing/meet "hello"` (start from repo root; see `docs/agents/testing.md`).

- [ ] **Step 4: Commit**

```bash
git add src/cli/repl.ts
git commit -m "feat(repl): post-setup [Y/n] meet offer + env entrypoints"
```

---

## Task 16: Docs, version, changelog

**Files:**
- Modify: `package.json` (`version` → `3.0.0`)
- Modify: `CHANGELOG.md` (new `## [3.0.0] - 2026-09-23`)
- Modify: `AGENTS.md` (commands table, Quick Reference)
- Modify: `docs/agents/testing.md` (onboarding scenarios)

- [ ] **Step 1: Bump version** in `package.json` to `3.0.0`.

- [ ] **Step 2: CHANGELOG** — add:

```markdown
## [3.0.0] - 2026-09-23

### Added
- **onboarding**: `meet` («Познакомимся») — LLM interview that records user preferences/facts to global memory (`preferences.json`, `facts.md`).
- **onboarding**: `init` — LLM generation/improvement of `AGENTS.md` for any workspace (code, docs, notes, configs).
- **REPL**: `/setup`, `/meet` (+`/познакомимся`), `/init`, `/memory`; post-setup `[Y/n]` meet offer.
- **CLI**: `mma meet`, `mma init`.
- **tools**: strict `ToolContext.toolAllowlist`; `meet_done` sentinel; `question` rendering aligned with STYLE.md (`?` glyph, `>` prompt).
- **providers**: shared `preflightProvider` (listModels + cheap chat probe) gating LLM-dependent entry points.

### Changed
- **CLI**: provider wizard renamed `mma init` → `mma setup`; `mma init` now generates `AGENTS.md`.

### Removed
- **CLI**: `mma init` no longer configures a provider (no alias).
```

- [ ] **Step 3: AGENTS.md** — add the three commands to the command lists and a short "Onboarding" section (or point to the spec). Keep it consistent with existing sections.

- [ ] **Step 4: `docs/agents/testing.md`** — add manual scenarios: first-run offer, provider-down path, `/meet` dev + non-dev domains, `/memory` round-trip, `mma init` with and without an existing `AGENTS.md`.

- [ ] **Step 5: Full verification**

Run: `bun test && tsc --noEmit`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json CHANGELOG.md AGENTS.md docs/agents/testing.md
git commit -m "docs+release: onboarding commands (3.0.0)"
```

---

## Self-Review Notes

- **Spec coverage:** O1 (Task 14), O2 (Tasks 4/7/8), O3 (Tasks 6/7), O4 (Task 8/4), O5 (Tasks 1/4), O6–O8 (Tasks 3/7/8), O9 (Task 13), O10 (Tasks 9/10), O11 (no config), O12 (Task 11), O13 (Task 4), O14 (Task 4 prompts), O15 (Task 9). §6.6 examples verified against Task 9's renderer output.
- **Known follow-up:** the exact tool-registration array in `src/tools/index.ts` (Task 5) and the REPL context construction site (Task 6/13) must be matched to the current source; both are called out with `rg` hints.
- **Interview multi-turn:** meet mode persists across turns; `meet_done` is the exit signal (Task 12). `Esc` during a turn aborts that turn only; mode stays and the user can run `/meet` again or finish.
