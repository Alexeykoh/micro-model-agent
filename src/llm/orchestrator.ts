import type { LLMProvider, Message, Chunk } from "./provider";
import type { ProviderConfig, RateLimitConfig, RetryConfig } from "../config/types";
import type { Logger } from "../logger/app-logger";
import type { MoEPlan } from "../modules/execution/types";
import type { OrchestratorResult, VerifyInput } from "./types";
import { ProviderManager } from "../modules/providers/manager";
import { FallbackProvider } from "../modules/providers/fallback";
import { jsonrepair } from "jsonrepair";
import { parseChunks } from "./response";

export interface OrchestratorConfig {
  model?: string;
  /** Full provider config — entries[] or legacy {type,baseUrl,apiKey}. */
  provider?: ProviderConfig;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  /** Fallback context window when the provider entry does not specify one. */
  contextWindow?: number;
  logger?: Logger;
  /** Expert registry rendered into the planner prompt (Plan 3.1). */
  experts?: Record<string, { description?: string; tool_tags?: string[] }>;
}

const PLAN_SYSTEM_PROMPT_RULES = `Rules:
1. Each subtask must have an expert_tag from the available experts.
2. Use depends_on for ordering when subtask B reads what subtask A writes.
3. Independent subtasks should NOT depend on each other (they run in parallel).
4. allowed_files is for files the subtask will CREATE or MODIFY.
5. read_only_files is for files the subtask needs to READ only.
6. File paths should be relative to the workspace root.
7. Do NOT use keyword matching to determine task type. Instead, analyze the actual nature of the task.

Respond with a JSON object only (no markdown fences):
{
  "title": "Plan title",
  "subtasks": [
    {
      "id": "task-1",
      "description": "Clear description",
      "expert_tag": "code",
      "allowed_files": ["src/file.ts"],
      "read_only_files": [],
      "depends_on": [],
      "input_from": [],
      "expected_output": "What this subtask produces",
      "success_criteria": ["criterion 1", "criterion 2"]
    }
  ],
  "shared_context": {
    "rules": ["rule 1"],
    "refs": []
  }
}`;

const PLAN_SYSTEM_PROMPT = `You are a planning assistant for an agent system with multiple expert sub-agents.
Break down the user's task into subtasks that can be executed by different expert agents.

Available experts and their tool tags:
- code: file operations, code editing, shell commands
- research: web search, web fetch, web browse, history search
- browser: browser automation, screenshots
- vision: browser + file reading for visual tasks

${PLAN_SYSTEM_PROMPT_RULES}`;

/**
 * Render the planner system prompt from the configured experts instead of the
 * hardcoded code/research/browser/vision list, so user-defined experts
 * (config.experts) are visible to the Router. Experts without a description
 * fall back to their tool_tags. Empty/missing registry → legacy hardcoded
 * prompt (back-compat for direct OrchestratorClient usage in tests).
 */
export function buildPlanSystemPrompt(
  experts?: Record<string, { description?: string; tool_tags?: string[] }>,
): string {
  if (!experts || Object.keys(experts).length === 0) {
    return PLAN_SYSTEM_PROMPT;
  }
  const lines = Object.entries(experts).map(([tag, cfg]) => {
    const desc =
      cfg.description ||
      (cfg.tool_tags?.length ? `tools: ${cfg.tool_tags.join(", ")}` : "general purpose");
    return `- ${tag}: ${desc}`;
  });
  return `You are a planning assistant for an agent system with multiple expert sub-agents.
Break down the user's task into subtasks that can be executed by different expert agents.

Available experts and their tool tags:
${lines.join("\n")}

${PLAN_SYSTEM_PROMPT_RULES}`;
}

const VERIFY_SYSTEM_PROMPT = `You are a verification and merge assistant for an agent system with multiple expert sub-agents.
You receive the original plan, the results from each subtask, and any verification errors.
Your job is to determine if the overall task was completed successfully or if re-planning is needed.

Respond with JSON only:
- If successful: {"type": "final", "finalAnswer": "summary of results", "explanation": "details"}
- If re-plan needed: {"type": "replan", "plan": {updated MoEPlan}, "explanation": "why re-plan is needed"}

Max 3 re-plan cycles. After 3 cycles, return partial result.`;

const SCOPE_DECISION_SYSTEM_PROMPT = `You are the router of a multi-expert agent system. A sub-agent could not finish its task because it lacked access to files outside its assigned scope.
Decide what to do with its scope request:
- "approve" — grant access ONLY to files it justifies; keep write grants minimal.
- "reject" — when the request is unjustified, excessive, or another subtask owns those files.

Respond with JSON only (no markdown fences):
{"action": "approve", "write": ["file1"], "read": ["file2"]}
or
{"action": "reject", "explanation": "why"}`;

const DEFAULT_BASE_URL = "http://localhost:1234/v1";

/** Fallback context window when neither the provider entry nor the config sets one. */
const DEFAULT_ORCH_CONTEXT_WINDOW = 32768;

export class OrchestratorClient {
  private config: OrchestratorConfig;
  private provider: LLMProvider | null = null;
  private getSessionId?: () => string | undefined;

  constructor(
    config: OrchestratorConfig,
    defaultProvider?: LLMProvider,
    opts?: { getSessionId?: () => string | undefined },
  ) {
    this.config = config;
    this.getSessionId = opts?.getSessionId;
    if (!config.model) return;

    if (config.provider) {
      this.provider = this.buildManagedProvider(config);
    } else if (defaultProvider) {
      this.provider = defaultProvider;
    } else {
      this.provider = this.buildManagedProvider({
        ...config,
        provider: { type: "openai-compat", baseUrl: DEFAULT_BASE_URL },
      });
    }
  }

  /**
   * Build the orchestrator provider through ProviderManager so per-entry
   * contextWindow/retry/rateLimits and failover entries are honored
   * (legacy {type,baseUrl,apiKey} configs are normalized by the manager).
   * Previously the provider was built directly with a hardcoded 32768 window
   * and no retry/rate-limit/failover support at all.
   */
  private buildManagedProvider(config: OrchestratorConfig): LLMProvider {
    const providerCfg = config.provider!;
    const manager = new ProviderManager(
      { ...providerCfg, baseUrl: providerCfg.baseUrl || DEFAULT_BASE_URL },
      {
        contextWindow: config.contextWindow ?? DEFAULT_ORCH_CONTEXT_WINDOW,
        retry: config.retry,
        rateLimits: config.rateLimits,
        getSessionId: this.getSessionId,
        logger: config.logger,
      },
    );
    manager.setModel(config.model!);

    let provider: LLMProvider = manager.active;
    if (providerCfg.fallback && manager.listNames().length > 1) {
      provider = new FallbackProvider(manager, (from, to, error) => {
        config.logger?.warn(
          `orchestrator provider failover: ${from} -> ${to} (${error.message.slice(0, 120)})`,
        );
      });
    }
    return provider;
  }

  isEnabled(): boolean {
    return this.provider !== null;
  }

  private async chat(messages: Message[], signal?: AbortSignal): Promise<string> {
    if (!this.provider) throw new Error("Orchestrator not enabled");
    const chunks: Chunk[] = [];
    for await (const chunk of this.provider.chat(messages, undefined, signal)) {
      chunks.push(chunk);
    }
    const parsed = parseChunks(chunks);
    return parsed.type === "text" ? parsed.content : "";
  }

  private parseJSON<T>(text: string): T | null {
    try {
      return JSON.parse(text) as T;
    } catch {
      try {
        const repaired = jsonrepair(text);
        return JSON.parse(repaired) as T;
      } catch {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const repaired = jsonrepair(jsonMatch[0]);
            return JSON.parse(repaired) as T;
          } catch {
            /* fall through */
          }
        }
        return null;
      }
    }
  }

  async plan(
    userPrompt: string,
    _context?: string,
    signal?: AbortSignal,
  ): Promise<{ plan: MoEPlan; raw: string } | { error: string }> {
    if (!this.provider)
      return { error: "Orchestrator not enabled — no orchestrator model configured" };

    const messages: Message[] = [
      { role: "system", content: buildPlanSystemPrompt(this.config.experts) },
      { role: "user", content: userPrompt },
    ];

    const text = await this.chat(messages, signal);
    const parsed = this.parseJSON<MoEPlan>(text);

    if (parsed?.subtasks && parsed.subtasks.length > 0) {
      return { plan: parsed, raw: text };
    }

    return { error: `Failed to parse plan from LLM output. Raw: ${text.slice(0, 500)}` };
  }

  async verifyAndMerge(input: VerifyInput, signal?: AbortSignal): Promise<OrchestratorResult> {
    if (!this.provider)
      return { type: "final", finalAnswer: input.results.map((r) => r.summary).join("\n") };

    const context = JSON.stringify(input, null, 2);
    const messages: Message[] = [
      { role: "system", content: VERIFY_SYSTEM_PROMPT },
      { role: "user", content: context },
    ];

    const text = await this.chat(messages, signal);
    const parsed = this.parseJSON<OrchestratorResult>(text);

    if (parsed?.type) {
      return parsed;
    }

    return {
      type: "final",
      finalAnswer: input.results.map((r) => r.summary).join("\n"),
      explanation: "Failed to parse verifier output, returning collected results.",
    };
  }

  /**
   * Router decision on a sub-agent's scope request. Defaults to reject on any
   * parse failure — scope must never expand silently.
   */
  async resolveScopeRequest(
    subtaskId: string,
    request: { files: string[]; read_only: boolean; reason: string },
    signal?: AbortSignal,
  ): Promise<
    | { action: "approve"; write: string[]; read: string[] }
    | { action: "reject"; explanation?: string }
  > {
    if (!this.provider) return { action: "reject", explanation: "orchestrator not enabled" };

    const messages: Message[] = [
      { role: "system", content: SCOPE_DECISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({ subtaskId, request }, null, 2),
      },
    ];

    const text = await this.chat(messages, signal);
    const parsed = this.parseJSON<{
      action?: string;
      write?: unknown;
      read?: unknown;
      explanation?: string;
    }>(text);

    if (parsed && parsed.action === "approve") {
      const write = Array.isArray(parsed.write) ? parsed.write.map(String) : [];
      const read = Array.isArray(parsed.read) ? parsed.read.map(String) : [];
      // An approve without any concrete files is meaningless — treat as reject.
      if (write.length === 0 && read.length === 0) {
        return { action: "reject", explanation: "approve carried no files" };
      }
      return { action: "approve", write, read };
    }

    return {
      action: "reject",
      explanation:
        parsed?.action === "reject"
          ? parsed.explanation
          : `unparseable router decision: ${text.slice(0, 200)}`,
    };
  }

  async createPlan(task: string): Promise<{ steps: string[] }> {
    if (!this.provider) throw new Error("Orchestrator not enabled");

    const messages: Message[] = [
      {
        role: "system",
        content:
          'You are a planning assistant. Break down tasks into steps. Respond with JSON only: {"steps": ["step 1", "step 2", ...]}',
      },
      { role: "user", content: task },
    ];

    const text = await this.chat(messages);

    const parsed = this.parseJSON<{ steps: string[] }>(text);
    if (parsed) return parsed;
    return { steps: [task] };
  }

  async resolveConflict(context: string): Promise<string> {
    if (!this.provider) throw new Error("Orchestrator not enabled");

    const messages: Message[] = [
      {
        role: "system",
        content:
          "You are a conflict resolution assistant. Analyze the situation and recommend the best path forward.",
      },
      { role: "user", content: context },
    ];

    const chunks: Chunk[] = [];
    for await (const chunk of this.provider.chat(messages)) {
      chunks.push(chunk);
    }
    const parsed = parseChunks(chunks);
    return parsed.type === "text" ? parsed.content : "";
  }
}
