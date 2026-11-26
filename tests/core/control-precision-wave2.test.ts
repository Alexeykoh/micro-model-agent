// BCP-2/3: каноничная подсказка блокировки и мягкий бюджет тулов.
import { describe, it, expect } from "vitest";
import { checkBlockedClaim, collectBlockedResults } from "../../src/core/agent/blocked-claim-gate";
import { ToolBatchExecutor } from "../../src/core/agent/tool-batch";
import { createLoopState } from "../../src/core/agent/loop-state";
import { SOFT_TOOL_BUDGET } from "../../src/core/agent/constants";
import { makeToolBatchDeps } from "../helpers/tool-batch-deps";

describe("BCP-2: искажение подсказки блокировки", () => {
  const blocked = [
    {
      role: "tool",
      blocked: true,
      content:
        'URL not allowed: http://127.0.0.1:7335/ — Private address "127.0.0.1" is blocked (SSRF) ' +
        "Action: for a local dev server enable security.network.allowLoopback=true, or use web_fetch with a public URL.",
    },
  ];

  it("находит каноничную строку в blocked-результате", () => {
    const found = collectBlockedResults(blocked);
    expect(found).toHaveLength(1);
    expect(found[0]!.canonical).toContain("security.network.allowLoopback=true");
  });

  it("требует переответа при пересказе подсказки", () => {
    const found = collectBlockedResults(blocked);
    const bad = "For http://127.0.0.1:7335/ try starting the server with the same config env instead.";
    expect(checkBlockedClaim(bad, found).reanswer).toBe(true);
    const good = `Blocked. ${found[0]!.canonical}`;
    expect(checkBlockedClaim(good, found).reanswer).toBe(false);
  });
});

describe("BCP-3: мягкий бюджет тулов", () => {
  it("финализирует после 12 вызовов", async () => {
    const calls = Array.from({ length: SOFT_TOOL_BUDGET }, (_, i) => ({
      id: String(i),
      name: "read_file",
      arguments: { path: `f${i}.txt` },
    }));
    const ex = new ToolBatchExecutor(
      makeToolBatchDeps({ execute: async () => ({ success: true, output: "ok" }) }),
    );
    const state = createLoopState();
    const res = await ex.execute(state, calls, new Set(), "checking files", "", "task");
    expect(state.toolCallsThisTurn).toBe(SOFT_TOOL_BUDGET);
    expect(res.finalize).toBe("soft_tool_budget");
  });
});
