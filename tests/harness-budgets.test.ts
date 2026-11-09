import { describe, it, expect } from "vitest";
import { validateWriteChunk, WRITE_CHUNK_LIMIT } from "../src/tools/write-file";
import { isAliasModuleError } from "../src/modules/lsp/write-check";
import { mutationTargetKey } from "../src/core/agent/loop-nudges";
import { bumpBudgetAfterWriteTooLarge } from "../src/core/agent/tool-batch-effects";
import { createLoopState } from "../src/core/agent/loop-state-init";
import { createLoopState } from "../src/core/agent/loop-state-init";
import { advancePlanIfStepComplete, looksLikeScaffoldTemplate } from "../src/modules/execution/step-advance";
import { PlanTracker } from "../src/modules/execution/tracker";
import { PlanStore } from "../src/modules/execution/plan-store";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { proactiveBudgetAfterLargeWrite } from "../src/core/agent/tool-batch-effects";
import { toWireMessage } from "../src/llm/request-body";

describe("INV-H7 wire messages for opencode-go", () => {
  it("strips internal success/blocked/arguments from tool messages", () => {
    const w = toWireMessage({ role: "tool", content: "ok", tool_call_id: "1", name: "write_file", success: true, blocked: false, arguments: { path: "a" } } as never);
    expect(w).toEqual({ role: "tool", content: "ok", tool_call_id: "1", name: "write_file" });
  });
  it("keeps assistant tool_calls intact", () => {
    const w = toWireMessage({ role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "write_file", arguments: "{}" } }], success: true } as never);
    expect("success" in w).toBe(false);
    expect(w.tool_calls).toBeDefined();
  });
});

describe("INV-H2 write chunk", () => {
  it("rejects content above chunk limit with append hint", () => {
    const r = validateWriteChunk("a.ts", "x".repeat(WRITE_CHUNK_LIMIT + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.output).toMatch(/append_file/i);
  });
  it("accepts content at limit", () => {
    expect(validateWriteChunk("a.ts", "x".repeat(WRITE_CHUNK_LIMIT)).ok).toBe(true);
  });
});

describe("INV-H4 alias tolerance", () => {
  it("suppresses alias module errors", () => {
    expect(isAliasModuleError("Cannot find module '@/lib/schemas/product' or its corresponding type declarations.")).toBe(true);
    expect(isAliasModuleError("Cannot find name 'process'")).toBe(false);
  });
});

describe("INV-H5 bash-key normalization", () => {
  it("collapses version variants of same command", () => {
    const a = mutationTargetKey("bash", JSON.stringify({ command: "npx --yes shadcn@4.22.0 add -y button" }));
    const b = mutationTargetKey("bash", JSON.stringify({ command: "npx --yes shadcn@4.21.0 add -y button" }));
    const c = mutationTargetKey("bash", JSON.stringify({ command: "npx shadcn@latest add -y button" }));
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe("INV-H1 budget bump after chunk failure", () => {
  it("raises iterMaxTokensOverride on write_too_large", () => {
    const s = createLoopState();
    bumpBudgetAfterWriteTooLarge(
      s,
      { id: "1", name: "write_file", arguments: { path: "a.ts", content: "x" } } as never,
      { success: false, output: "too large: 9000 > 8000" } as never,
    );
    expect(s.iterMaxTokensOverride).toBe(16384);
  });
  it("does not bump on success or unrelated failures", () => {
    const s = createLoopState();
    bumpBudgetAfterWriteTooLarge(s, { id: "1", name: "write_file", arguments: {} } as never, { success: true, output: "ok" } as never);
    expect(s.iterMaxTokensOverride).toBeUndefined();
    bumpBudgetAfterWriteTooLarge(s, { id: "1", name: "write_file", arguments: {} } as never, { success: false, output: "syntax error" } as never);
    expect(s.iterMaxTokensOverride).toBeUndefined();
  });
});

describe("INV-H3 template guard", () => {
  it("detects create-next-app page template", () => {
    expect(looksLikeScaffoldTemplate('import Image from "next/image";\n// To get started, edit the page.tsx', "C:/proj/src/app/page.tsx")).toBe(true);
    expect(looksLikeScaffoldTemplate("export default function Page(){ return null }", "src/app/page.tsx")).toBe(false);
  });
  it("proactive bump on large successful write", () => {
    const s = createLoopState();
    proactiveBudgetAfterLargeWrite(
      s,
      { id: "1", name: "write_file", arguments: { path: "a.ts", content: "x".repeat(5000) } } as never,
      { success: true, output: "ok" } as never,
    );
    expect(s.iterMaxTokensOverride).toBe(16384);
  });
});

describe("INV-H3 honest auto-advance", () => {
  it("does not advance when typecheck still failing", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mma-honest-"));
    mkdirSync(join(baseDir, "src"), { recursive: true });
    writeFileSync(join(baseDir, "src", "a.ts"), 'export const a = 1;\n');
    const plan = {
      id: "p1",
      title: "T",
      steps: [{ id: 1, description: "Create src/a.ts", status: "pending" as const, kind: "create" as const }],
      currentStepIndex: 0,
      createdAt: new Date(Date.now() - 1000).toISOString(),
      baseDir,
    };
    const tracker = new PlanTracker(plan as never);
    const store = new PlanStore(baseDir);
    const pending: Array<{ role: "user"; content: string }> = [];
    advancePlanIfStepComplete({
      baseDir,
      tracker,
      store,
      depsGateHints: new Map(),
      pendingMessages: pending,
      autoAdvance: true,
      typecheckFailures: new Map([["src/a.ts", "src/a.ts(1,7): error TS2322: bad"]]),
      flushSessionPlan: () => {},
      setPendingAutoArchive: () => {},
    });
    expect(tracker.getProgressString()).not.toContain("1/1");
    expect(pending.some((m) => m.content.includes("a.ts"))).toBe(true);
  });
});
