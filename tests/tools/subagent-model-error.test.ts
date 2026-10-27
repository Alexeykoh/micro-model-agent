/**
 * Провайдерская ошибка «Model is unavailable» у субагента (сессия из вопроса):
 * сырой JSON гейтвея должен уходить в вывод вместе с читаемой подсказкой —
 * какая модель запрашивалась и где её поправить.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isModelUnavailableError,
  formatSubagentFailure,
} from "../../src/tools/subagent-model-error";
import { subagentTool } from "../../src/tools/subagent";

const PROVIDER_JSON =
  '{"error":"Model \\"expert-model\\" is unavailable."}}';

describe("isModelUnavailableError", () => {
  it("detects the provider JSON from the failing session", () => {
    expect(isModelUnavailableError(PROVIDER_JSON)).toBe(true);
  });

  it("detects a plain provider message", () => {
    expect(isModelUnavailableError("Model foo is unavailable, retry later")).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isModelUnavailableError("Sub-agent failed: timeout")).toBe(false);
    expect(isModelUnavailableError("model context length exceeded")).toBe(false);
    expect(isModelUnavailableError("")).toBe(false);
  });
});

describe("formatSubagentFailure", () => {
  it("appends the requested model and expert_tag on unavailable model", () => {
    const out = formatSubagentFailure(PROVIDER_JSON, "", "code", "expert-model");
    expect(out).toContain("expert-model");
    expect(out).toContain('expert_tag "code"');
    expect(out).toContain(PROVIDER_JSON);
  });

  it("notes the parent model is already used when no expert_tag given", () => {
    const out = formatSubagentFailure(PROVIDER_JSON, "", undefined, "active-model");
    expect(out).toContain("active-model");
    expect(out).toContain("parent model");
  });

  it("leaves other failures untouched", () => {
    const out = formatSubagentFailure("timeout", "partial", undefined, "active-model");
    expect(out).toContain("timeout");
    expect(out).not.toContain("unavailable on the provider");
  });
});

describe("subagent run with unavailable model", () => {
  it("surfaces a readable hint naming the model", async () => {
    const run = vi.fn().mockResolvedValue({
      success: false,
      text: "",
      error: PROVIDER_JSON,
      iterationCount: 0,
    });
    const ctx: any = {
      baseDir: "/tmp/ws",
      config: {
        model: "active-model",
        contextWindow: 32768,
        contextBudget: {
          systemPrompt: 0.25,
          responseReserve: 0.12,
          compactionThreshold: 0.75,
        },
      },
      logger: { info() {}, error() {}, warn() {}, debug() {} },
      sessionId: "ses_model_unavailable_test",
      toolExecutor: {
        setScope: () => {},
        getScope: () => undefined,
        getRegistry: () => ({ getByTags: () => [] }),
      },
      agentFactory: () => ({ run, shutdown: () => {} }),
      llmProvider: { chat: async () => {}, countTokens: () => 1 },
    };
    const result = await subagentTool.handler(ctx, { task: "audit the landing" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("active-model");
    expect(result.output).toContain("parent model");
  });
});
