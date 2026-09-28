/** Клиент оркестратора MoE: план, verifyAndMerge, scope-роутер. */
import type { LLMProvider, Message, Chunk } from "./provider";
import type { ProviderConfig, RateLimitConfig, RetryConfig } from "../config/types";
import type { Logger } from "../logger/app-logger";
import type { MoEPlan } from "../modules/execution/types";
import type { OrchestratorResult, VerifyInput } from "./types";
import { ProviderManager } from "../modules/providers/manager";
import { FallbackProvider } from "../modules/providers/fallback";
import { jsonrepair } from "jsonrepair";
import { parseChunks } from "./response";

/** Конфиг оркестратора: модель, провайдер, ретраи, эксперты. */
export interface OrchestratorConfig {
  model?: string;
  /** Полный конфиг провайдера — entries[] или легаси {type,baseUrl,apiKey}. */
  provider?: ProviderConfig;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  /** Запасное окно контекста, если запись провайдера его не задаёт. */
  contextWindow?: number;
  logger?: Logger;
  /** Реестр экспертов в промпт планировщика (Plan 3.1). */
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

/** Запасное окно контекста, если ни запись провайдера, ни конфиг его не задают. */
const DEFAULT_ORCH_CONTEXT_WINDOW = 32768;

/** Клиент оркестратора: строит план, сливает результаты, роутит scope-запросы. */
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
   * Строит провайдер оркестратора через ProviderManager: учитываются
   * per-entry contextWindow/retry/rateLimits и failover-записи (легаси
   * {type,baseUrl,apiKey} менеджер нормализует). Раньше провайдер строился
   * напрямую с хардкодом окна 32768 — без ретраев/лимитов/failover вовсе.
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

  /**
   * Включён ли оркестратор (задана ли модель).
   * @returns true, если провайдер построен.
   */
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

  /**
   * Строит MoE-план из задачи пользователя.
   * @param userPrompt задача; @param _context неиспользуемый контекст;
   * @returns план с сырым ответом либо ошибку.
   */
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

  /**
   * Сливает результаты сабтасков: финал либо запрос re-plan.
   * @param input план, результаты, ошибки/варнинги верификатора;
   * @returns финал с ответом либо replan с обновлённым планом.
   */
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
   * Решение роутера по scope-запросу субагента. Дефолт на любой ошибке
   * парсинга — reject: scope молча не расширяется никогда.
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
      // Approve без конкретных файлов бессмыслен — считаем reject.
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

  /**
   * Строит простой план-список шагов (легаси-поверхность).
   * @param task задача; @returns шаги плана (фолбэк — сама задача).
   */
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

  /**
   * Рекомендует путь разрешения конфликта.
   * @param context описание ситуации; @returns рекомендация текстом.
   */
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
