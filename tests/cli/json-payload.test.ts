import { describe, it, expect } from "vitest";
import { buildJsonError, buildJsonResult } from "../../src/cli/json-payload";
import type { AgentResult } from "../../src/core/types";

const result: AgentResult = {
  success: true,
  text: "done",
  iterationCount: 3,
  totalTokens: 42,
};

describe("buildJsonResult", () => {
  it("includes captured diagnostics and coalesces optional fields", () => {
    const payload = buildJsonResult(result, [
      { level: "warn", source: "probe.context", text: "context smaller than configured" },
    ]);

    expect(payload).toMatchObject({
      success: true,
      text: "done",
      error: null,
      iterationCount: 3,
      contextUsed: null,
      contextLimit: null,
      promptTokens: null,
      totalTokens: 42,
      totalCost: null,
      costBreakdown: [],
      cache: null,
      diagnostics: [
        { level: "warn", source: "probe.context", text: "context smaller than configured" },
      ],
    });
  });

  it("emits an empty diagnostics array when no warnings were captured", () => {
    expect(buildJsonResult(result, []).diagnostics).toEqual([]);
  });
});

describe("buildJsonError", () => {
  it("defaults to no diagnostics and a valid failure shape", () => {
    expect(buildJsonError("bootstrap blew up")).toEqual({
      success: false,
      text: "",
      error: "bootstrap blew up",
      iterationCount: 0,
      diagnostics: [],
    });
  });

  it("accepts captured diagnostics", () => {
    const diagnostics = [{ level: "error", source: "config", text: "parse failed" }];
    expect(buildJsonError("boom", diagnostics).diagnostics).toEqual(diagnostics);
  });
});
