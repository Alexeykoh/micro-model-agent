/**
 * Субагент на той же модели, что и агент: `experts[tag]` без `model`/`provider`
 * наследует активного провайдера, а явный пин исполняется на своей модели.
 * Плюс INV-E3 — дочерний агент видит в конфиге модель, на которой реально
 * исполняется (токены/цена/лог не врут).
 *
 * Спека `2026-11-01-experts-model-selection-design`.
 */
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { subagentTool } from "../../src/tools/subagent";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig, ExpertConfig } from "../../src/config/types";
import type { LLMProvider } from "../../src/llm/provider";

interface CapturedDeps {
  llmProvider: LLMProvider;
  config: AppConfig;
}

function baseConfig(experts: Record<string, ExpertConfig>): AppConfig {
  const c = structuredClone(DEFAULTS);
  c.model = "active-model";
  c.provider = {
    type: "openai-compat",
    baseUrl: "http://localhost:1234/v1",
    entries: [
      { type: "openai-compat", label: "local", baseUrl: "http://localhost:1234/v1" },
      { type: "openai-compat", label: "remote", baseUrl: "https://remote.example/v1" },
    ],
    active: "local",
  } as AppConfig["provider"];
  c.experts = experts;
  c.subagent = { ...(c.subagent ?? {}), stableSystemPrompt: true, resultMode: "text" };
  return c;
}

function makeCtx(config: AppConfig, parentProvider: LLMProvider, captured: CapturedDeps[]) {
  return {
    config,
    baseDir: tmpdir(),
    sessionId: "ses_subagent_same_model",
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    llmProvider: parentProvider,
    toolExecutor: {
      getRegistry: () => ({
        getByTags: (tags: string[]) =>
          (tags || []).map((tag) => ({ name: "read_file", description: "d", parameters: {}, tags: [tag] })),
      }),
      setScope: () => {},
      getScope: () => undefined,
      setRecursionDepth: () => {},
      getRecursionDepth: () => 0,
    } as never,
    agentFactory: (deps: unknown) => {
      captured.push(deps as CapturedDeps);
      return {
        run: async () => ({ success: true, text: "done", iterationCount: 1 }),
      };
    },
  } as never;
}

function parentProvider(): LLMProvider {
  return { chat: async () => ({}), countTokens: () => 1 } as unknown as LLMProvider;
}

/**
 * baseUrl собранного провайдера с разворотом обёрток: в полном прогоне
 * data-policy egress уже включён другим тестом и `ProviderManager.active`
 * приходит как `SanitizingProvider` (у него `inner`).
 */
function baseUrlOf(provider: unknown): string {
  let cur = provider as
    | { config?: { baseUrl?: string }; inner?: unknown; source?: { active?: unknown } }
    | undefined;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur.config?.baseUrl === "string") return cur.config.baseUrl;
    if (cur.inner) {
      cur = cur.inner as typeof cur;
      continue;
    }
    if (cur.source?.active) {
      cur = cur.source.active as typeof cur;
      continue;
    }
    break;
  }
  return "";
}

describe("subagent inherits the active model unless the expert pins one", () => {
  it("runs an expert without a model on the parent provider and active model", async () => {
    const captured: CapturedDeps[] = [];
    const parent = parentProvider();
    const config = baseConfig({ code: { tool_tags: ["file"] } });
    const result = await subagentTool.handler(makeCtx(config, parent, captured), {
      task: "do it",
      expert_tag: "code",
    });
    expect(result.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].llmProvider).toBe(parent);
    expect(captured[0].config.model).toBe("active-model");
  });

  it("runs a pinned expert on its own model and reports that model to the child", async () => {
    const captured: CapturedDeps[] = [];
    const parent = parentProvider();
    const config = baseConfig({ code: { model: "expert-model", tool_tags: ["file"] } });
    const result = await subagentTool.handler(makeCtx(config, parent, captured), {
      task: "do it",
      expert_tag: "code",
    });
    expect(result.success).toBe(true);
    expect(captured[0].llmProvider).not.toBe(parent);
    expect((captured[0].llmProvider as unknown as { model: string }).model).toBe("expert-model");
    // INV-E3: отчётность идёт по фактической модели.
    expect(captured[0].config.model).toBe("expert-model");
  });

  it("builds the pinned expert on its provider entry", async () => {
    const captured: CapturedDeps[] = [];
    const config = baseConfig({
      code: { model: "remote-model", provider: "remote", tool_tags: ["file"] },
    });
    const result = await subagentTool.handler(makeCtx(config, parentProvider(), captured), {
      task: "do it",
      expert_tag: "code",
    });
    expect(result.success).toBe(true);
    expect(String(baseUrlOf(captured[0].llmProvider))).toContain("remote.example");
  });
});
