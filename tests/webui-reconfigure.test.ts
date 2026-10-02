import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../src/config/types";
import { makeReconfigure } from "../src/modules/webui/reconfigure";
import { createWebUiState } from "../src/modules/webui/state";

describe("webui reconfigure", () => {
  it("runs the after-hook (model refresh) after reconfigure", async () => {
    const state = createWebUiState();
    let reconfigured = 0;
    let afterRuns = 0;
    const agent = {
      reconfigure: () => {
        reconfigured++;
      },
      contextManager: { getBudget: () => ({ history: 123 }) },
    };
    const fn = makeReconfigure(state, agent, async () => {
      afterRuns++;
    });
    await fn({} as AppConfig);
    expect(reconfigured).toBe(1);
    expect(afterRuns).toBe(1);
    expect(state.usage?.contextLimit).toBe(123);
  });

  it("does not fail when the after-hook rejects", async () => {
    const state = createWebUiState();
    const agent = {
      reconfigure: () => {},
      contextManager: { getBudget: () => ({ history: 1 }) },
    };
    const fn = makeReconfigure(state, agent, () => {
      throw new Error("provider offline");
    });
    await expect(fn({} as AppConfig)).resolves.toBeUndefined();
  });
});
