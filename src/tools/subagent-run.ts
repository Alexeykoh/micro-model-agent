// Исполнение тула `subagent` — вынесено из `subagent.ts` (правило ≤300).
// Определение тула (схема/теги) остаётся в `subagent.ts`.
import { t } from "../i18n/index";
import type { ToolContext, ToolScope, ToolResult } from "./types";
import { Agent } from "../core/agent";
import { ContextManager } from "../core/context/manager";
import { HallucinationDetector } from "../core/hallucination/detector";
import { PluginManager } from "../modules/plugins/manager";
import type { PromptBlock } from "../core/types";
import { logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { ArtifactStore } from "../modules/artifacts/store";
import { ScopeDenialCollector, formatScopeRequest } from "./scope-request";
import { getExpertConfig } from "../config/experts";
import { resolveExpertProvider } from "../modules/execution/expert-provider";
import { withTokenCap } from "../llm/token-cap";

/** Фиксированный системный промпт (KV-cache дружит при stableSystemPrompt). */
export const SUBAGENT_SYSTEM_PROMPT_TEMPLATE = `You are a sub-agent working on a specific task. You have your own context window and tool set.

Workflow rules:
- Prefer small, focused steps. Verify your own work (typecheck/tests) before finishing.
- For large outputs, write the result to a file with write_file instead of reproducing it in your answer.
- If the task is big and decomposable, delegate parts to the subagent tool instead of doing everything in one context.
- When you finish, return a concise final answer; do not repeat file contents verbatim if you already wrote them to disk.`;

/** Собирает системный промпт субагента (стабильный или с контекстом). */
function buildSubagentSystemPrompt(context: string, stable: boolean): string {
  if (stable) return SUBAGENT_SYSTEM_PROMPT_TEMPLATE;
  return `You are a sub-agent working on a specific task. ${context ? `Context: ${context}` : ""}`;
}

/** Минимальный и максимальный кап completion-токенов субагента. */
export const MAX_TOKENS_MIN = 1;
export const MAX_TOKENS_MAX = 32000;

/**
 * Разбирает `max_tokens`: число в диапазоне — кап, `undefined` — без капа,
 * `"invalid"` — значение задано, но недопустимо.
 */
export function parseMaxTokens(
  raw: unknown,
): number | undefined | "invalid" {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MAX_TOKENS_MIN || value > MAX_TOKENS_MAX) {
    return "invalid";
  }
  return Math.floor(value);
}

/** Спавнит изолированного субагента и возвращает его результат. */
export async function runSubagent(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {  const task = String(args.task || "");
  const context = String(args.context || "");

  if (!task) {
    return { success: false, output: t("tool.name_or_task") };
  }

  // Сессионный security-конфиг.
  const securityConfig = ctx.sessionContext
    ? getSessionSecurityConfig(ctx.config, ctx.sessionContext)
    : ctx.config.security;

  // Лимит глубины рекурсии. Глубину читаем из SHARED-контекста исполнителя
  // (его видят вложенные субагенты) — `ctx.recursionDepth` снапшотился раз.
  const executor = ctx.toolExecutor;
  const parentDepth = executor?.getRecursionDepth?.() ?? (ctx.recursionDepth ?? 0);
  const maxDepth = securityConfig?.maxRecursionDepth ?? 3;
  const currentDepth = parentDepth;

  if (currentDepth >= maxDepth) {
    logSecurityBlock(
      ctx.sessionId,
      "bash_command",
      `Maximum recursion depth (${maxDepth}) exceeded`,
      task,
    );
    return {
      success: false,
      output: `[SECURITY BLOCKED] Maximum sub-agent recursion depth (${maxDepth}) exceeded`,
    };
  }

  const scope: ToolScope | undefined =
    args.allowed_files || args.read_only_files
      ? {
          allowed_files: (args.allowed_files as string[]) || [],
          read_only_files: (args.read_only_files as string[]) || [],
        }
      : ctx.scope;

  const explicitTags = args.tool_tags ? (args.tool_tags as string[]) : undefined;
  const expertTag = args.expert_tag ? String(args.expert_tag) : undefined;
  // expert_tag — сахар над tool_tags: если явные теги не даны, берём tags
  // сконфигурированного эксперта.
  let toolTags = explicitTags;
  let expertModel: string | undefined;
  if (expertTag) {
    const expert = getExpertConfig(ctx.config, expertTag);
    if (!expert) {
      const known = Object.keys(ctx.config.experts ?? {});
      return {
        success: false,
        output: `[SECURITY BLOCKED] Unknown expert_tag "${expertTag}". Known experts: [${known.join(", ") || "none"}]. Pass a configured expert tag or explicit tool_tags.`,
      };
    }
    expertModel = expert.model;
    if (!toolTags || toolTags.length === 0) toolTags = expert.tool_tags;
  }

  if (!ctx.llmProvider || !ctx.toolExecutor) {
    return { success: false, output: t("tool.subagent_cannot_run") };
  }

  // Модель эксперта (если задан expert_tag) исполняется на выделенном
  // провайдере поверх активного; иначе — общий провайдер родителя.
  const baseProvider = resolveExpertProvider(
    ctx.config,
    expertModel,
    ctx.llmProvider,
    ctx.logger,
    () => ctx.sessionId,
  );

  // Кап completion-токенов, заданный вызывающим (`max_tokens`).
  const cap = parseMaxTokens(args.max_tokens);
  if (cap === "invalid") {
    return {
      success: false,
      output: t("tool.subagent_max_tokens_invalid", {
        min: String(MAX_TOKENS_MIN),
        max: String(MAX_TOKENS_MAX),
      }),
    };
  }
  const provider = cap ? withTokenCap(baseProvider, cap) : baseProvider;

  // Оборонительный гард: запрошенные tool_tags ни с чем не мэтчатся — у
  // субагента ноль тулов, и он галлюцинирует вместо действий.
  if (toolTags && toolTags.length > 0) {
    const matched = ctx.toolExecutor.getRegistry().getByTags(toolTags);
    if (matched.length === 0) {
      return {
        success: false,
        output: `[SECURITY BLOCKED] No tools match the requested tool_tags: [${toolTags.join(", ")}]. Check the subagent tool_tags parameter and retry with valid tags (e.g. "file", "code", "shell", "research").`,
      };
    }
  }

  // Сейв/рестор shared-скоупа исполнителя, чтобы субагент не мутировал скоуп
  // родителя навсегда.
  const parentScope = executor?.getScope?.() ?? ctx.scope;
  const appliedScope = scope || { allowed_files: [], read_only_files: [] };
  // Compare-and-restore: параллельный сабагент мог тем временем поставить
  // свой скоуп — чужого свежего владельца не затирать.
  const restoreScope = () => {
    if (ctx.toolExecutor?.getScope?.() === appliedScope) {
      ctx.toolExecutor.setScope(parentScope);
    }
  };

  try {
    // Изолированный контекст сабагента; project-леджер (contextBudget.notesPath)
    // намеренно НЕ подключается — сабагент не делит durable адреса с родителем.
    const subContextManager = new ContextManager(
      ctx.config.contextWindow,
      ctx.config.contextBudget,
    );
    const subPluginManager = new PluginManager();
    const scopeCollector = new ScopeDenialCollector();
    subPluginManager.register(scopeCollector.plugin, "builtin");
    const hallucinationDetector = new HallucinationDetector(ctx.baseDir, provider);

    ctx.toolExecutor.setScope(appliedScope);
    // Cleanup на исполнителе — рестор скоупа при таймауте/аборте, даже если
    // `finally` агента не отработал (брошенный промис).
    ctx.cleanup = restoreScope;
    ctx.recursionDepth = currentDepth + 1;
    executor?.setRecursionDepth?.(currentDepth + 1);

    const systemPrompt: PromptBlock = {
      content: buildSubagentSystemPrompt(
        context,
        ctx.config.subagent?.stableSystemPrompt !== false,
      ),
      priority: "critical",
      essential: true,
      estimatedTokens: 150,
    };

    // Сабагент идёт тем же одиночным циклом, что и родитель.
    const subConfig = { ...ctx.config };

    const subDeps = {
      config: subConfig,
      llmProvider: provider,
      toolExecutor: ctx.toolExecutor,
      pluginManager: subPluginManager,
      contextManager: subContextManager,
      hallucinationDetector,
      logger: ctx.logger,
      baseDir: ctx.baseDir,
      scope,
      toolTags,
      promptBlocks: [systemPrompt],
    };

    const subAgent = (ctx.agentFactory ?? ((d: unknown) => new Agent(d as never)))(subDeps);
    const fullTask = context ? `${task}\n\nContext: ${context}` : task;
    try {
      const result = await subAgent.run(fullTask);
      const pickUsage = () =>
        result.promptTokens !== undefined || result.totalTokens !== undefined
          ? {
              promptTokens: result.promptTokens ?? 0,
              completionTokens: result.completionTokens ?? 0,
              totalTokens: result.totalTokens ?? 0,
            }
          : undefined;
      if (!result.success) {
        let output = t("tool.subagent_failed", {
          error: String(result.error),
          text: result.text,
        });
        const scopeReq = scopeCollector.toScopeRequest();
        if (scopeReq) output += `\n${formatScopeRequest(scopeReq)}`;
        return { success: false, output };
      }

      const resultMode =
        (args.result_mode as string) || ctx.config.subagent?.resultMode || "text";

      if (resultMode === "file") {
        const store = new ArtifactStore({
          baseDir: ctx.baseDir,
          sessionId: ctx.sessionId || "default",
          artifactsDir: ctx.config.subagent?.artifactsDir,
        });
        const abs = store.save(
          (args.artifact_name as string) || `subagent-${Date.now()}`,
          result.text,
          "md",
        );
        const summary = store.summary(result.text, ctx.config.subagent?.maxSummaryChars ?? 2000);
        ctx.logger.debug(
          `subagent result persisted to artifact ${abs} (${result.text.length} chars, ${result.iterationCount} iterations)`,
        );
        return {
          success: true,
          output: t("tool.subagent_artifact", {
            path: abs,
            iterations: String(result.iterationCount),
            summary,
          }),
          artifactPath: abs,
          usage: pickUsage(),
        };
      }

      return {
        success: true,
        output: t("tool.subagent_completed", {
          text: result.text,
          iterations: String(result.iterationCount),
        }),
        usage: pickUsage(),
      };
    } finally {
      // Рестор точного скоупа родителя (compare-and-restore).
      restoreScope();
      if (ctx.cleanup === restoreScope) ctx.cleanup = undefined;
      ctx.recursionDepth = currentDepth;
      executor?.setRecursionDepth?.(currentDepth);
    }
  } catch (e: any) {
    return { success: false, output: t("tool.subagent_error", { error: e.message }) };
  }
}
