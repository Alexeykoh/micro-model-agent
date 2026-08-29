import { createProvider } from "../modules/providers/create";
import type { LLMProvider, Message } from "./provider";
import type { RetryConfig } from "../config/types";
import type { MoEPlan } from "../modules/execution/types";
import type { OrchestratorResult, VerifyInput } from "./types";
import { jsonrepair } from "jsonrepair";

export interface OrchestratorConfig {
  model?: string;
  provider?: {
    type?: string;
    baseUrl?: string;
    apiKey?: string;
  };
  retry?: RetryConfig;
}

const PLAN_SYSTEM_PROMPT = `You are a planning assistant for an agent system with multiple expert sub-agents.
Break down the user's task into subtasks that can be executed by different expert agents.

Available experts and their tool tags:
- code: file operations, code editing, shell commands
- research: web search, web fetch, web browse, history search
- browser: browser automation, screenshots
- vision: browser + file reading for visual tasks

Rules:
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

export class OrchestratorClient {
  private config: OrchestratorConfig;
  private provider: LLMProvider | null = null;

  constructor(config: OrchestratorConfig, defaultProvider?: LLMProvider) {
    this.config = config;
    if (config.model) {
      if (config.provider) {
        this.provider = createProvider(config.provider.type ?? "openai-compat", {
          model: config.model,
          baseUrl: config.provider.baseUrl || "http://localhost:1234/v1",
          apiKey: config.provider.apiKey,
          contextWindow: 32768,
          retry: config.retry,
        });
      } else if (defaultProvider) {
        this.provider = defaultProvider;
      } else {
        this.provider = createProvider("openai-compat", {
          model: config.model,
          baseUrl: "http://localhost:1234/v1",
          contextWindow: 32768,
          retry: config.retry,
        });
      }
    }
  }

  isEnabled(): boolean {
    return this.provider !== null;
  }

  private async chat(messages: Message[], signal?: AbortSignal): Promise<string> {
    if (!this.provider) throw new Error("Orchestrator not enabled");
    const chunks: any[] = [];
    for await (const chunk of this.provider.chat(messages, undefined, signal)) {
      chunks.push(chunk);
    }
    return chunks
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.content)
      .join("");
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
      { role: "system", content: PLAN_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    const text = await this.chat(messages, signal);
    const parsed = this.parseJSON<MoEPlan>(text);

    if (parsed && parsed.subtasks && parsed.subtasks.length > 0) {
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

    if (parsed && parsed.type) {
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

    try {
      return JSON.parse(text);
    } catch {
      return { steps: [task] };
    }
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

    let result = "";
    for await (const chunk of this.provider.chat(messages)) {
      if (chunk.type === "text" && chunk.content) result += chunk.content;
    }

    return result;
  }
}
