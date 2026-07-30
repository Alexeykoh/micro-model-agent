import { describe, it, expect } from "vitest";
import { mcpCallTool } from "../../src/tools/mcp-call";
import type { ToolContext } from "../../src/tools/types";

const mockCtx = (): ToolContext => ({
  config: {
    version: "2.0.0",
    model: "test",
    provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    orchestrator: {},
    moe: { enabled: false },
    experts: {},
    contextWindow: 4096,
    contextBudget: {
      systemPrompt: 0.25,
      responseReserve: 0.12,
      compactionThreshold: 0.75,
    },
    modelLoad: { autoLoad: false },
    retry: { maxRetries: 3, baseDelay: 1000, maxDelay: 30000 },
    maxToolIterations: 5,
    stuckThreshold: 8,
    autoPlan: true,
    showReasoning: true,
    logLevel: "info",
    locale: "en",
    session: { autoSave: true, maxSessions: 50, isolateMemory: false },
    browser: {
      enabled: true,
      headless: true,
      maxElements: 30,
      viewportWidth: 1280,
      viewportHeight: 720,
      navigationTimeout: 15000,
    },
    mcpServers: {},
  } as any,
  baseDir: "/tmp",
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any,
});

describe("mcpCallTool", () => {
  it("has correct definition", () => {
    expect(mcpCallTool.name).toBe("mcp_call");
    expect(mcpCallTool.description).toBeTruthy();
    expect(mcpCallTool.parameters.required).toContain("server");
    expect(mcpCallTool.parameters.required).toContain("tool");
    const props = mcpCallTool.parameters.properties as Record<string, any>;
    expect(props.server).toBeDefined();
    expect(props.tool).toBeDefined();
    expect(props.args).toBeDefined();
  });

  it("fails when server not found", async () => {
    const result = await mcpCallTool.handler(mockCtx(), {
      server: "nonexistent-server",
      tool: "some-tool",
      args: {},
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("fails when server name is empty", async () => {
    const result = await mcpCallTool.handler(mockCtx(), {
      server: "",
      tool: "some-tool",
    });

    expect(result.success).toBe(false);
  });

  it("fails when tool name is empty", async () => {
    const result = await mcpCallTool.handler(mockCtx(), {
      server: "some-server",
      tool: "",
    });

    expect(result.success).toBe(false);
  });
});
