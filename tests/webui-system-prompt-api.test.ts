import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { handleSystemPromptGet } from "../src/modules/webui/session/system-prompt-api";
import type { RunPool } from "../src/modules/webui/session/session-pool";

function capture(): { res: ServerResponse; body: () => unknown } {
  let raw = "";
  const res = {
    writeHead: () => {},
    end: (chunk: string) => {
      raw = chunk;
    },
  } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(raw) };
}

describe("GET /api/sessions/:id/system-prompt", () => {
  it("returns prompt text and block composition for a live runner", () => {
    const pool = {
      getRunner: () => ({
        agent: {
          getSystemPromptInfo: () => ({
            text: "SYSTEM",
            tokenCount: 3,
            budget: 100,
            excluded: ["map"],
            blocks: [{ label: "system", priority: "high", tokens: 3, included: true }],
          }),
        },
      }),
    } as unknown as RunPool;
    const out = capture();
    handleSystemPromptGet(out.res, "s1", pool);
    expect(out.body()).toEqual({
      available: true,
      text: "SYSTEM",
      tokenCount: 3,
      budget: 100,
      excluded: ["map"],
      blocks: [{ label: "system", priority: "high", tokens: 3, included: true }],
    });
  });

  it("does not synthesize a runner for a session that never ran", () => {
    const pool = { getRunner: () => undefined } as unknown as RunPool;
    const out = capture();
    handleSystemPromptGet(out.res, "s1", pool);
    expect(out.body()).toEqual({ available: false, reason: "no_active_runner" });
  });
});
