import { describe, it, expect } from "vitest";
import { sessionInfoTool } from "../../src/tools/session-info";
import type { ToolContext } from "../../src/tools/types";

function makeCtx(
  meta: ReturnType<NonNullable<ToolContext["sessionManager"]>["getActiveMeta"]>,
  snapshot?: { tokens: number; budget: { history: number } },
) {
  return {
    config: { provider: { active: "lmstudio", type: "openai" } },
    sessionManager: { getActiveMeta: () => meta },
    contextManager: snapshot ? { getSnapshot: () => snapshot } : undefined,
  } as unknown as ToolContext;
}

describe("session_info tool", () => {
  it("reports no active session when none exists", async () => {
    const result = await sessionInfoTool.handler(makeCtx(null), {});
    expect(result.success).toBe(true);
    expect(result.output).toContain("No active session");
  });

  it("returns session metadata for the active session", async () => {
    const result = await sessionInfoTool.handler(
      makeCtx({
        id: "ses_abc",
        name: "My Session",
        model: "qwen3.5-9b",
        contextWindow: 32768,
        messageCount: 7,
        createdAt: "2026-09-15T10:00:00.000Z",
        updatedAt: "2026-09-15T10:05:00.000Z",
      }),
      {},
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("ses_abc");
    expect(result.output).toContain("My Session");
    expect(result.output).toContain("qwen3.5-9b");
    expect(result.output).toContain("32768");
    expect(result.output).toContain("lmstudio");
  });

  it("reports context usage when a context manager is available", async () => {
    const result = await sessionInfoTool.handler(
      makeCtx(
        {
          id: "ses_abc",
          name: "My Session",
          model: "qwen3.5-9b",
          contextWindow: 32768,
          messageCount: 7,
          createdAt: "2026-09-15T10:00:00.000Z",
          updatedAt: "2026-09-15T10:05:00.000Z",
        },
        { tokens: 2400, budget: { history: 4800 } },
      ),
      {},
    );
    expect(result.output).toContain("50%");
    expect(result.output).toContain("2400");
  });

  it("survives tag-based tool filtering", () => {
    expect(sessionInfoTool.alwaysOn).toBe(true);
  });
});
