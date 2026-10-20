# Counter-Agent (In-Loop Critic) — Implementation Plan

> **Статус:** исполнено (2026-10-20) — контр-агент v1 (`src/modules/critic/**`,
> `src/core/agent/critic-gate.ts`, конфиг `critic.*`, `SessionLogger.logCritic`, i18n) и
> Phase 2 (выделенный провайдер, ограниченный read-only tool-loop) реализованы; позже
> доведены волнами critic W1–W5 (`68b83f55`…`48911546`). Чекбоксы проставлены по факту.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evidence-grounded, event-triggered LLM critic to the single-agent loop that advises on `concern` and performs a bounded repair on `critical`, failing open.

**Architecture:** `src/modules/critic/` (types + evidence builder + LLM client) and `src/core/agent/critic-gate.ts` (trigger/authority/dedupe), wired into `executeSingleAgentLoop` next to `AuditGate`/`HallucinationGate`. MoE path untouched. v1 uses the active provider.

**Tech Stack:** Bun + TypeScript, vitest, `LLMProvider.chat`, `jsonrepair`, i18n.

**Spec:** `docs/specs/2026-09-25-session-autoname-and-critic-design.md` §4 (+ §5 literature).

**Deferred (Phase 2, tracked in `TODO.md`, NOT part of this plan):** dedicated critic provider (`critic.provider`/`critic.model` via ProviderManager) and the bounded read-only tool-loop (`critic.tools`). v1 uses the active provider and the deterministic evidence pack only.

---

## File Structure

- Create: `src/modules/critic/types.ts` — `CriticVerdict`, `CriticIssue`, `EvidencePack`.
- Create: `src/modules/critic/evidence.ts` — `buildEvidencePack`, `isWorkMutation`.
- Create: `src/modules/critic/client.ts` — `CriticClient`, `parseVerdict`, `CRITIC_SYSTEM_PROMPT`.
- Create: `src/core/agent/critic-gate.ts` — `CriticGate`.
- Modify: `src/core/agent/loop-state.ts` — critic counters.
- Modify: `src/core/agent.ts` — create gate, trigger, `AgentDeps` seams.
- Modify: `src/core/session-logger.ts`, `src/modules/session/store.ts` — `logCritic` + log types.
- Modify: `src/config/types.ts`, `src/config/defaults.ts` — `critic` domain.
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`.
- Test: `tests/critic-evidence.test.ts`, `tests/critic-client.test.ts`, `tests/critic-gate.test.ts`, `tests/core/agent-critic.test.ts`.
- Modify: `docs/agents/architecture.md`, `AGENTS.md`, `CHANGELOG.md`, `TODO.md`.

---

### Task 1: Types + evidence builder

**Files:**
- Create: `src/modules/critic/types.ts`, `src/modules/critic/evidence.ts`
- Test: `tests/critic-evidence.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildEvidencePack, isWorkMutation } from "../src/modules/critic/evidence";

describe("critic evidence", () => {
  it("detects work mutations", () => {
    expect(isWorkMutation("write_file")).toBe(true);
    expect(isWorkMutation("edit_file")).toBe(true);
    expect(isWorkMutation("bash")).toBe(true);
    expect(isWorkMutation("read_file")).toBe(false);
    expect(isWorkMutation("plan")).toBe(false);
  });

  it("collects changed files, commands and a bounded digest", () => {
    const pack = buildEvidencePack({
      task: "fix bug",
      planSummary: "step 1 -> done",
      toolEvents: [
        { tool: "write_file", args: { path: "src/a.ts" }, ok: true },
        { tool: "bash", args: { command: "bun test" }, ok: false },
        { tool: "read_file", args: { path: "src/a.ts" }, ok: true },
      ],
    });
    expect(pack.changedFiles).toContain("src/a.ts");
    expect(pack.commands[0]).toEqual({ command: "bun test", exitCode: 1 });
    expect(pack.toolDigest.split("\n")).toHaveLength(3);
  });
});
```

- [x] **Step 2: Run** — `bun test tests/critic-evidence.test.ts` → FAIL (module missing).

- [x] **Step 3: Implement**

Create `src/modules/critic/types.ts`:

```ts
export type CriticSeverity = "info" | "concern" | "critical";

export interface CriticIssue {
  severity: CriticSeverity;
  claim: string;
  problem: string;
  suggestion?: string;
  evidence?: string;
}

export interface CriticVerdict {
  status: "ok" | "concern" | "critical";
  summary: string;
  issues: CriticIssue[];
}

export interface EvidencePack {
  task: string;
  planSummary?: string;
  changedFiles: string[];
  commands: Array<{ command: string; exitCode?: number }>;
  toolDigest: string;
}
```

Create `src/modules/critic/evidence.ts`:

```ts
import type { EvidencePack } from "./types";
import { summarizeToolArgs } from "../../core/agent/tool-output";

const MUTATING_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file", "create_dir"]);

/** Work mutation = filesystem-changing tool (bash counts; plan/todo bookkeeping does not). */
export function isWorkMutation(name: string): boolean {
  return MUTATING_TOOLS.has(name) || name === "bash";
}

export interface EvidenceToolEvent {
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
}

export interface EvidenceInput {
  task: string;
  planSummary?: string;
  toolEvents: EvidenceToolEvent[];
}

const MAX_DIGEST_LINES = 40;

export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const changedFiles = new Set<string>();
  const commands: EvidencePack["commands"] = [];
  const digest: string[] = [];
  for (const ev of input.toolEvents) {
    const args = ev.args ? summarizeToolArgs(ev.args) : "";
    digest.push(`${ev.ok === false ? "✗" : "✓"} ${ev.tool} ${args}`.trim());
    if (
      (ev.tool === "write_file" || ev.tool === "edit_file") &&
      typeof ev.args?.path === "string"
    ) {
      changedFiles.add(ev.args.path);
    }
    if (ev.tool === "bash" && typeof ev.args?.command === "string") {
      commands.push({ command: ev.args.command, exitCode: ev.ok === false ? 1 : 0 });
    }
  }
  return {
    task: input.task,
    planSummary: input.planSummary,
    changedFiles: [...changedFiles],
    commands,
    toolDigest: digest.slice(-MAX_DIGEST_LINES).join("\n"),
  };
}
```

- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** — `feat(critic): evidence pack builder`.

---

### Task 2: CriticClient + verdict parsing

**Files:**
- Create: `src/modules/critic/client.ts`
- Test: `tests/critic-client.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseVerdict, CriticClient } from "../src/modules/critic/client";
import type { LLMProvider } from "../src/llm/provider";

function providerReturning(text: string): LLMProvider {
  return {
    model: "m", contextWindow: 1000, countTokens: () => 0, listModels: async () => [],
    async *chat() {
      yield { type: "text" as const, content: text };
      yield { type: "done" as const };
    },
  };
}

describe("parseVerdict", () => {
  it("parses plain JSON", () => {
    expect(parseVerdict('{"status":"ok","summary":"fine","issues":[]}')?.status).toBe("ok");
  });
  it("repairs slightly broken JSON", () => {
    expect(parseVerdict('{"status":"concern","summary":"x","issues":[]')?.status).toBe("concern");
  });
  it("returns null on garbage", () => {
    expect(parseVerdict("not json")).toBeNull();
  });
});

describe("CriticClient", () => {
  it("fails open to null on provider error", async () => {
    const provider: LLMProvider = {
      model: "m", contextWindow: 1000, countTokens: () => 0, listModels: async () => [],
      // eslint-disable-next-line require-yield
      async *chat() { throw new Error("boom"); },
    };
    const client = new CriticClient({ provider });
    expect(await client.verify({ task: "t", changedFiles: [], commands: [], toolDigest: "" })).toBeNull();
  });
});
```

- [x] **Step 2: Run** → FAIL.

- [x] **Step 3: Implement `src/modules/critic/client.ts`**

```ts
import { jsonrepair } from "jsonrepair";
import type { LLMProvider, Message } from "../../llm/provider";
import type { CriticVerdict, EvidencePack, CriticIssue } from "./types";

export const CRITIC_SYSTEM_PROMPT = `You are a strict but fair verifier ("counter-agent") reviewing an AI agent's in-progress work.
Rules:
- Flag ONLY issues that can be verified from the evidence provided. Do not speculate or invent.
- Do not nitpick style, wording, or preferences unless the user's task demanded it.
- If the evidence is insufficient to judge, return status "ok" (prefer silence over noise).
- "critical" = the task's stated result is demonstrably not delivered. "concern" = a concrete, checkable gap. "info" = minor.
- Every issue must reference concrete evidence (file, command, output).
Reply with JSON ONLY:
{"status":"ok|concern|critical","summary":"one line","issues":[{"severity":"info|concern|critical","claim":"...","problem":"...","suggestion":"...","evidence":"..."}]}`;

export interface CriticClientOptions {
  provider: LLMProvider;
  maxTokens?: number;
  timeoutMs?: number;
}

export class CriticClient {
  constructor(private readonly opts: CriticClientOptions) {}

  isEnabled(): boolean {
    return true;
  }

  async verify(pack: EvidencePack, signal?: AbortSignal): Promise<CriticVerdict | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15000);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const messages: Message[] = [
        { role: "system", content: CRITIC_SYSTEM_PROMPT },
        { role: "user", content: renderPack(pack) },
      ];
      let text = "";
      for await (const chunk of this.opts.provider.chat(messages, undefined, controller.signal, {
        maxTokens: this.opts.maxTokens ?? 512,
        reasoningEffort: "none",
      })) {
        if (chunk.type === "text" && chunk.content) text += chunk.content;
      }
      return parseVerdict(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function renderPack(pack: EvidencePack): string {
  return [
    `TASK: ${pack.task}`,
    pack.planSummary ? `PLAN: ${pack.planSummary}` : "",
    `CHANGED FILES: ${pack.changedFiles.join(", ") || "(none)"}`,
    `COMMANDS: ${pack.commands.map((c) => `${c.command} (exit ${c.exitCode ?? "?"})`).join("; ") || "(none)"}`,
    "TOOL TRAIL:",
    pack.toolDigest || "(empty)",
  ]
    .filter(Boolean)
    .join("\n");
}

const SEVERITIES = new Set(["info", "concern", "critical"]);

export function parseVerdict(text: string): CriticVerdict | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(jsonrepair(text));
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        parsed = JSON.parse(jsonrepair(match[0]));
      } catch {
        return null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (status !== "ok" && status !== "concern" && status !== "critical") return null;
  const issues: CriticIssue[] = Array.isArray(obj.issues)
    ? (obj.issues as unknown[])
        .filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        .map((i) => ({
          severity: (SEVERITIES.has(String(i.severity)) ? String(i.severity) : "concern") as CriticIssue["severity"],
          claim: String(i.claim ?? ""),
          problem: String(i.problem ?? ""),
          suggestion: i.suggestion ? String(i.suggestion) : undefined,
          evidence: i.evidence ? String(i.evidence) : undefined,
        }))
        .filter((i) => i.claim || i.problem)
    : [];
  return { status, summary: String(obj.summary ?? ""), issues };
}
```

- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** — `feat(critic): LLM client + JSON verdict parsing`.

---

### Task 3: CriticGate (triggers, authority, dedupe)

**Files:**
- Create: `src/core/agent/critic-gate.ts`
- Test: `tests/critic-gate.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { CriticGate } from "../src/core/agent/critic-gate";
import { createLoopState } from "../src/core/agent/loop-state";

function deps(overrides: Partial<any> = {}) {
  const state = createLoopState();
  state.mutationsSinceCritic = 3;
  return {
    state,
    iteration: 5,
    logger: { warn: vi.fn(), info: vi.fn() } as any,
    contextManager: { addMessage: vi.fn() } as any,
    slog: { logCritic: vi.fn() } as any,
    task: "do it",
    beforeFinish: true,
    toolEvents: [{ tool: "write_file", args: { path: "a" }, ok: true }],
    ...overrides,
  };
}

const okVerdict = { status: "ok" as const, summary: "", issues: [] };
const concern = { status: "concern" as const, summary: "gap", issues: [{ severity: "concern" as const, claim: "c", problem: "p" }] };
const critical = { status: "critical" as const, summary: "broken", issues: [{ severity: "critical" as const, claim: "c", problem: "p" }] };

describe("CriticGate", () => {
  it("skips when disabled or no mutations", async () => {
    const verify = vi.fn();
    const gate = new CriticGate({ enabled: false, maxCalls: 4, maxRepairCycles: 1, verify, buildPack: (d: any) => d });
    expect(await gate.evaluate(deps())).toBe("pass");
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns pass on ok verdict", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => okVerdict, buildPack: (d: any) => d });
    expect(await gate.evaluate(deps())).toBe("pass");
  });

  it("injects advice and retries on concern", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => concern, buildPack: (d: any) => d });
    expect(await gate.evaluate(deps())).toBe("retry");
  });

  it("repairs on critical, bounded by maxRepairCycles", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => critical, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("retry");
    expect(await gate.evaluate(d)).toBe("pass"); // repair budget spent -> accept
  });

  it("dedupes identical issues", async () => {
    const gate = new CriticGate({ enabled: true, maxCalls: 4, maxRepairCycles: 1, verify: async () => concern, buildPack: (d: any) => d });
    const d = deps();
    expect(await gate.evaluate(d)).toBe("retry");
    expect(await gate.evaluate(d)).toBe("pass");
  });

  it("stops after maxCalls", async () => {
    const verify = vi.fn(async () => concern);
    const gate = new CriticGate({ enabled: true, maxCalls: 1, maxRepairCycles: 1, verify, buildPack: (d: any) => d });
    await gate.evaluate(deps());
    expect(await gate.evaluate(deps())).toBe("pass");
  });
});
```

- [x] **Step 2: Run** → FAIL.

- [x] **Step 3: Implement `src/core/agent/critic-gate.ts`**

```ts
import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import type { CriticIssue, CriticVerdict, EvidencePack } from "../../modules/critic/types";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";

const MUTATIONS_BEFORE_CHECK = 3;

export interface CriticGateDeps {
  state: LoopState;
  iteration: number;
  logger: Logger;
  contextManager: ContextManager;
  slog: SessionLogger;
  task: string;
  planSummary?: string;
  toolEvents: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean }>;
  /** True when evaluated right before the loop would accept the final answer. */
  beforeFinish: boolean;
}

export type CriticAction = "pass" | "retry";

export interface CriticGateOptions {
  enabled: boolean;
  maxCalls: number;
  maxRepairCycles: number;
  verify: (pack: EvidencePack, signal?: AbortSignal) => Promise<CriticVerdict | null>;
  buildPack: (deps: CriticGateDeps) => EvidencePack;
  signal?: AbortSignal;
}

function issueSignature(issue: CriticIssue): string {
  return `${issue.severity}:${issue.claim}`.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function renderIssues(issues: CriticIssue[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `- [${i.severity}] ${i.problem || i.claim}${i.suggestion ? ` → ${i.suggestion}` : ""}`)
    .join("\n");
}

export class CriticGate {
  constructor(private readonly opts: CriticGateOptions) {}

  async evaluate(deps: CriticGateDeps): Promise<CriticAction> {
    if (!this.opts.enabled) return "pass";
    if (deps.state.criticCalls >= this.opts.maxCalls) return "pass";
    if (!deps.beforeFinish && deps.state.mutationsSinceCritic < MUTATIONS_BEFORE_CHECK) return "pass";
    if (deps.toolEvents.length === 0) return "pass";

    deps.state.criticCalls++;
    deps.state.mutationsSinceCritic = 0;

    const verdict = await this.opts.verify(this.opts.buildPack(deps), this.opts.signal);
    if (!verdict || verdict.status === "ok") return "pass";

    const fresh = verdict.issues.filter((issue) => {
      const sig = issueSignature(issue);
      if (deps.state.seenCriticIssues.has(sig)) return false;
      deps.state.seenCriticIssues.add(sig);
      return true;
    });
    if (fresh.length === 0) return "pass";

    deps.slog.logCritic("critic_verdict", {
      status: verdict.status,
      summary: verdict.summary,
      issueCount: fresh.length,
    });
    deps.logger.info(`Critic ${verdict.status}: ${verdict.summary} (${fresh.length} issue(s))`);

    const canRepair =
      verdict.status === "critical" &&
      deps.beforeFinish &&
      deps.state.criticRepairCycles < this.opts.maxRepairCycles;
    if (canRepair) {
      deps.state.criticRepairCycles++;
      deps.slog.logCritic("critic_escalation", { summary: verdict.summary, cycle: deps.state.criticRepairCycles });
      deps.contextManager.addMessage({
        role: "user",
        content: `<system-summary>${t("critic.repair", {
          summary: verdict.summary,
          issues: renderIssues(fresh),
        })}</system-summary>`,
      });
      return "retry";
    }

    deps.contextManager.addMessage({
      role: "user",
      content: `<system-summary>${t("critic.advice", { issues: renderIssues(fresh) })}</system-summary>`,
    });
    return "retry";
  }
}
```

- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** — `feat(critic): critic gate (triggers, dedupe, bounded repair)`.

---

### Task 4: Config `critic`

**Files:** `src/config/types.ts`, `src/config/defaults.ts`; Test: `tests/config.test.ts`

- [x] **Step 1: Failing test**

```ts
it("defaults critic to enabled with bounded loops", () => {
  expect(DEFAULTS.critic).toEqual({ enabled: true, maxCalls: 4, maxRepairCycles: 1, timeoutMs: 15000 });
});
```

- [x] **Step 2: Run** → FAIL.

- [x] **Step 3:** Add to `types.ts`:

```ts
export interface CriticConfig {
  enabled: boolean;
  /** Hard cap on critic LLM calls per run. */
  maxCalls: number;
  /** Bounded number of critical-triggered repair cycles per run. */
  maxRepairCycles: number;
  timeoutMs: number;
}
```

Add `critic: CriticConfig;` to `AppConfig`. Add to `defaults.ts`:

```ts
  critic: {
    enabled: true,
    maxCalls: 4,
    maxRepairCycles: 1,
    timeoutMs: 15000,
  },
```

- [x] **Step 4: Run** → PASS (also `bun test tests/config.test.ts`).
- [x] **Step 5: Commit** — `feat(config): add critic domain`.

---

### Task 5: LoopState counters + SessionLogger

**Files:** `src/core/agent/loop-state.ts`, `src/core/session-logger.ts`, `src/modules/session/store.ts`; Test: `tests/session-logger.test.ts`, `tests/core/agent-critic.test.ts` (later)

- [x] **Step 1:** Add fields to `LoopState` + init in `createLoopState()`:

```ts
  /** Critic LLM calls made this run. */
  criticCalls: number;
  /** Repair cycles consumed this run. */
  criticRepairCycles: number;
  /** Work mutations accumulated since the last critic call. */
  mutationsSinceCritic: number;
  /** Dedupe signatures of critic issues already surfaced. */
  seenCriticIssues: Set<string>;
```

init: `criticCalls: 0, criticRepairCycles: 0, mutationsSinceCritic: 0, seenCriticIssues: new Set(),`

- [x] **Step 2:** Add `"critic_check" | "critic_verdict" | "critic_escalation"` to `SessionLogEntry.type` (`src/modules/session/store.ts:18-41`).
- [x] **Step 3:** Add to `SessionLogger`:

```ts
  /** Log a critic lifecycle event (counter-agent). */
  logCritic(
    event: "critic_check" | "critic_verdict" | "critic_escalation",
    data: Record<string, unknown> = {},
  ): void {
    this.session?.appendLog({
      ts: new Date().toISOString(),
      type: event,
      content: (data.summary as string) ?? event,
      ...data,
    });
  }
```

- [x] **Step 4:** `bun test tests/session-logger.test.ts` → PASS; `tsc --noEmit`.
- [x] **Step 5: Commit** — `feat(critic): loop counters + session logging`.

---

### Task 6: Agent integration

**Files:** `src/core/agent.ts`; Test: `tests/core/agent-critic.test.ts`

- [x] **Step 1: Write the failing test**

Build a minimal `AgentDeps` with a stub provider that (a) emits a `write_file` tool call then a final text, and (b) scripted critic verdicts via `AgentDeps.criticOverride`. Assert:
- verdict `critical` → agent injects a `<system-summary>` and makes another LLM call (does not accept on the first final text);
- verdict `ok` → accepts normally;
- critic throwing → run completes (fail-open).

```ts
const gate = { verify: async () => criticalVerdict, buildPack: (d: any) => d };
```

- [x] **Step 2: Run** → FAIL.

- [x] **Step 3: Implement in `src/core/agent.ts`**

Add to `AgentDeps` (after `runWithMoEOverride`):

```ts
  /** Test seam — replaces the real critic verify (Bun module mocks are process-global). */
  criticOverride?: {
    verify: (pack: import("../modules/critic/types").EvidencePack, signal?: AbortSignal) => Promise<import("../modules/critic/types").CriticVerdict | null>;
  };
```

Add imports:

```ts
import { CriticGate } from "./agent/critic-gate";
import { CriticClient } from "../modules/critic/client";
import { buildEvidencePack, isWorkMutation } from "../modules/critic/evidence";
```

Near `const auditGate = new AuditGate(this.deps.finalAudit);` (line ~722):

```ts
    const criticClient = new CriticClient({
      provider: this.deps.llmProvider,
      timeoutMs: config.critic.timeoutMs,
    });
    const criticGate = new CriticGate({
      enabled: config.critic.enabled,
      maxCalls: config.critic.maxCalls,
      maxRepairCycles: config.critic.maxRepairCycles,
      verify: this.deps.criticOverride?.verify ?? ((pack, signal) => criticClient.verify(pack, signal)),
      buildPack: (d) => buildEvidencePack({ task: d.task, planSummary: d.planSummary, toolEvents: d.toolEvents }),
      signal: this.abortController?.signal,
    });
```

In the tool-call accounting block (after the `for (const tc of toolCalls)` loop at line ~1107) add:

```ts
        for (const tc of toolCalls) {
          if (isWorkMutation(tc.name)) state.mutationsSinceCritic++;
        }
```

At the finish point, immediately before `const auditVerdict = await auditGate.evaluate({...})` (line ~1230), insert:

```ts
      const criticAction = await criticGate.evaluate({
        state,
        iteration: state.iteration,
        logger,
        contextManager,
        slog,
        task: input,
        planSummary: this.deps.planSummary?.(),
        toolEvents: gatherTurnToolEvents(contextManager),
        beforeFinish: true,
      });
      if (criticAction === "retry") {
        state.suppressRepetitionRetry = true;
        continue;
      }
```

Add a module-level helper at the bottom of `critic-gate.ts` (export it and import):

```ts
export function gatherTurnToolEvents(contextManager: {
  getActiveHistory: () => Array<{ role: string; name?: string; content?: unknown; success?: boolean }>;
}): Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean }> {
  const events: Array<{ tool: string; args?: Record<string, unknown>; ok?: boolean }> = [];
  for (const m of contextManager.getActiveHistory()) {
    if (m.role !== "tool" || !m.name) continue;
    events.push({ tool: m.name, ok: m.success });
  }
  return events;
}
```

(Args are not present on tool history messages; `gatherTurnToolEvents` yields tool names + success only. Changed files are separately derivable — extend later if needed; v1 evidence still names tools/commands via digest without args. Keep the helper in `critic-gate.ts` and unit-test it in Task 3.)

- [x] **Step 4: Run** → `bun test tests/core/agent-critic.test.ts` PASS.
- [x] **Step 5: Commit** — `feat(agent): wire in-loop critic gate`.

---

### Task 7: UI/i18n + docs

**Files:** `src/i18n/en.json`, `src/i18n/ru.json`, `src/ui/renderer.ts` (only if a quiet line is desired), `docs/agents/architecture.md`, `AGENTS.md`, `CHANGELOG.md`, `TODO.md`.

- [x] **Step 1:** Add i18n keys:

```json
"critic.repair": "A verifier flagged critical problems; fix them before finishing:\n{issues}\nSummary: {summary}",
"critic.advice": "A verifier flagged issues worth checking before you finish:\n{issues}"
```

RU mirror. (Injected as `<system-summary>` — model-facing, so keep the same language policy as other exec directives: English model-facing text is acceptable, RU optional.)
- [x] **Step 2:** Quiet UI: log only via `session.jsonl` (`critic_*` events). No chat line by default (STYLE.md quiet). Optionally `/verbose` later.
- [x] **Step 3:** CHANGELOG `### Added`: counter-agent (in-loop critic). AGENTS.md short bullet. architecture.md section. TODO.md: mark P4 counter-agent progress; add Phase 2 items (dedicated provider, read-only tool-loop).
- [x] **Step 4: Full gate**

Run: `bun test && tsc --noEmit && bun run lint`
Expected: green.

- [x] **Step 5: Commit** — `docs(critic): i18n, changelog, architecture`.

---

## Self-Review Checklist

- [x] Evidence pack is deterministic and bounded (Task 1).
- [x] Critic fails open on error/timeout/bad JSON (Task 2, 3).
- [x] Triggers only on work mutations, capped by `maxCalls`, deduped (Task 3).
- [x] Critical repair is bounded by `maxRepairCycles`; never infinite (Task 3).
- [x] MoE path untouched; AuditGate/HallucinationGate order preserved (Task 6).
- [x] Observability in `session.jsonl` (Task 5, 7).
- [x] Phase 2 (dedicated provider, read-only tools) explicitly deferred to `TODO.md`.
