import { describe, it, expect, vi } from "vitest";
import { OrchestratorClient, buildPlanSystemPrompt } from "../src/llm/orchestrator";
import type { LLMProvider } from "../src/llm/provider";

describe("buildPlanSystemPrompt", () => {
  it("falls back to the legacy hardcoded prompt without experts", () => {
    const prompt = buildPlanSystemPrompt();
    expect(prompt).toContain("- code: file operations, code editing, shell commands");
    expect(prompt).toContain("- vision: browser + file reading for visual tasks");
  });

  it("renders experts from the config registry (Plan 3.1)", () => {
    const prompt = buildPlanSystemPrompt({
      code: { description: "code expert", tool_tags: ["file", "code"] },
      qa: { tool_tags: ["shell"] },
    });
    expect(prompt).toContain("- code: code expert");
    // No description → derived from tool_tags
    expect(prompt).toContain("- qa: tools: shell");
    expect(prompt).not.toContain("- research:");
    expect(prompt).toContain("Available experts and their tool tags:");
  });
});

describe("OrchestratorClient", () => {
  it("should check if orchestrator is enabled", () => {
    const client = new OrchestratorClient({
      model: "gpt-4o",
      provider: {
        type: "openai-compat",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      },
    });
    expect(client.isEnabled()).toBe(true);
  });

  it("should be disabled when no model configured", () => {
    const client = new OrchestratorClient({});
    expect(client.isEnabled()).toBe(false);
  });

  it("should use same provider when no explicit provider given", () => {
    const client = new OrchestratorClient({
      model: "qwen3-70b",
    });
    expect(client.isEnabled()).toBe(true);
  });

  it("should create plan via orchestrator", async () => {
    const client = new OrchestratorClient({
      model: "gpt-4o",
      provider: {
        type: "openai-compat",
        baseUrl: "http://localhost:1234/v1",
      },
    });

    const mockChat = vi.fn();
    const mockChunks: any[] = [
      { type: "text", content: '{"steps": ["step1", "step2"]}' },
      { type: "done", finishReason: "stop" },
    ];
    mockChat.mockReturnValue(
      (async function* () {
        for (const c of mockChunks) yield c;
      })(),
    );

    (client as any).provider = { chat: mockChat };

    const plan = await client.createPlan("Implement OAuth");
    expect(plan).toBeDefined();
    expect(mockChat).toHaveBeenCalled();
  });

  it("should throw when disabled and asked to plan", async () => {
    const client = new OrchestratorClient({});
    await expect(client.createPlan("test")).rejects.toThrow("not enabled");
  });

  it("honors per-entry contextWindow from provider entries (no hardcoded 32768)", () => {
    const client = new OrchestratorClient({
      model: "orch-model",
      provider: {
        type: "openai-compat",
        baseUrl: "http://localhost:1234/v1",
        entries: [
          {
            type: "openai-compat",
            label: "orch",
            baseUrl: "http://localhost:1234/v1",
            contextWindow: 65536,
            retry: { maxRetries: 5, baseDelay: 10, maxDelay: 100 },
          },
        ],
        active: "orch",
      },
    });
    expect(client.isEnabled()).toBe(true);
    const provider = (client as any).provider as any;
    expect(provider.contextWindow).toBe(65536);
    expect(provider.retryConfig).toEqual({ maxRetries: 5, baseDelay: 10, maxDelay: 100 });
  });

  it("keeps legacy {type,baseUrl,apiKey} provider configs working", () => {
    const client = new OrchestratorClient({
      model: "gpt-4o",
      provider: {
        type: "openai-compat",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      },
    });
    expect(client.isEnabled()).toBe(true);
    const provider = (client as any).provider as any;
    expect(provider.model).toBe("gpt-4o");
    expect(provider.config.baseUrl).toBe("https://api.openai.com/v1");
    expect(provider.config.apiKey).toBe("sk-test");
  });

  it("applies config-level retry/rateLimits to the managed provider", () => {
    const retry = { maxRetries: 2, baseDelay: 5, maxDelay: 50 };
    const client = new OrchestratorClient({
      model: "m",
      provider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
      retry,
    });
    const provider = (client as any).provider as any;
    expect(provider.retryConfig).toEqual(retry);
  });
});

describe("OrchestratorClient default-model fallback (MoE out of the box)", () => {
  it("enables MoE on the active model when orchestrator.model is unset", () => {
    const defaultProvider = { chat: vi.fn(), countTokens: vi.fn() } as unknown as LLMProvider;
    const client = new OrchestratorClient({ fallbackModel: "active-model" }, defaultProvider);
    expect(client.isEnabled()).toBe(true);
    // Reuses the active provider object (no dedicated planner provider needed).
    expect((client as any).provider).toBe(defaultProvider);
  });

  it("builds a dedicated provider when orchestrator.model differs from the active model", () => {
    const client = new OrchestratorClient({
      model: "planner",
      fallbackModel: "active",
      fallbackProvider: { type: "openai-compat", baseUrl: "http://localhost:1234/v1" },
    });
    expect(client.isEnabled()).toBe(true);
    const provider = (client as any).provider as any;
    expect(provider.model).toBe("planner");
  });

  it("stays disabled when there is no model, no provider and no active provider", () => {
    expect(new OrchestratorClient({}).isEnabled()).toBe(false);
  });
});
