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
      content: "guide", priority: "high",
      essential: true, estimatedTokens: 10,
    };
    agent.pushPromptBlock(block);
    expect(agent.getPromptBlocksForTest()).toContain(block);
    agent.removePromptBlock(block);
    expect(agent.getPromptBlocksForTest()).not.toContain(block);
  });
});
