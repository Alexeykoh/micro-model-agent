// Исполнение тула `subagent` (определение — в `subagent.ts`; правило ≤300).
import { t } from "../i18n/index";
import type { ToolContext, ToolScope, ToolResult } from "./types";
import { Agent } from "../core/agent";
import { ContextManager } from "../core/context/manager";
import { HallucinationDetector } from "../core/hallucination/detector";
import { PluginManager } from "../modules/plugins/manager";
import type { PromptBlock } from "../core/types";
import { logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { ScopeDenialCollector, formatScopeRequest } from "./scope-request";
import { resolveExpertProvider } from "../modules/execution/expert-provider";
import { withTokenCap } from "../llm/token-cap";
import { MAX_TOKENS_MAX, MAX_TOKENS_MIN, parseMaxTokens } from "./subagent-limits";
import { lookupExpertTag } from "./subagent-expert";
import { formatSubagentFailure } from "./subagent-model-error";
import { createSubagentObserver, resultStatus, resultUsage } from "./subagent-observer";
import { setSubagentRunStop } from "./subagent-registry";
import type { SubagentUsageRecord } from "./subagent-runs";
import { createSubagentWatchdog } from "./subagent-watchdog";
import { finalizeSubagentSuccess } from "./subagent-result";
// Реэкспорт для существующих импортёров/тестов (лимиты переехали в отдельный файл).
export { MAX_TOKENS_MAX, MAX_TOKENS_MIN, parseMaxTokens } from "./subagent-limits";
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

/** Спавнит изолированного субагента и возвращает его результат. */
export async function runSubagent(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const task = String(args.task || "");
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
    const lookup = lookupExpertTag(ctx, expertTag);
    if (lookup.refusal) return { success: false, output: lookup.refusal };
    expertModel = lookup.expert?.model;
    if (!toolTags || toolTags.length === 0) toolTags = lookup.expert?.tool_tags;
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
  const provider = cap ? withTokenCap(baseProvider, cap, { maxExplicit: MAX_TOKENS_MAX }) : baseProvider;

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
    // Usage подпотока уходит в наблюдатель, а он создаётся ниже: ref замыкается
    // на него к моменту первого LLM-вызова (спека `2026-10-27-subagent-run-journal-design`).
    let reportUsage: ((usage: SubagentUsageRecord) => void) | undefined;
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
      onUsage: (usage: SubagentUsageRecord) => reportUsage?.(usage),
    };

    const subAgent = (ctx.agentFactory ?? ((d: unknown) => new Agent(d as never)))(subDeps);
    const fullTask = context ? `${task}\n\nContext: ${context}` : task;
    const observer = createSubagentObserver(ctx, {
      task,
      depth: currentDepth + 1,
      agent: expertTag,
      model: expertModel ?? ctx.config.model,
    });
    observer.start();
    reportUsage = (usage) => observer.callbacks.onUsage(usage);
    // Стоп родительского хода и кнопка «остановить» в вебе ведут в один
    // `subAgent.shutdown()`: у дочернего агента свой abort-контроллер.
    const stopSubAgent = (): void => subAgent.shutdown?.();
    setSubagentRunStop(observer.runId, stopSubAgent);
    const parentSignal = ctx.abortSignal;
    const onParentAbort = (): void => stopSubAgent();
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    ctx.subagentRuns?.registerInterrupt?.(observer.runId, stopSubAgent);

    // Прогресс-вотчдог: пока идут события — живём; молчание дольше idle или
    // превышение maxDuration останавливает дочернего агента (не только скоуп).
    const cleanupRun = (): void => {
      stopSubAgent();
      restoreScope();
    };
    ctx.cleanup = cleanupRun;
    const watchdog = createSubagentWatchdog({
      idleMs: ctx.config.subagent?.timeoutMs ?? 180000,
      maxMs: ctx.config.subagent?.maxDurationMs ?? 1800000,
      stop: stopSubAgent,
    });

    try {
      if (parentSignal?.aborted) {
        observer.finish("interrupted", 0, undefined, "aborted");
        return { success: false, output: t("tool.aborted", { name: "subagent" }) };
      }
      const result = await subAgent.run(
        fullTask,
        (chunk) => {
          watchdog.touch();
          observer.callbacks.onChunk(chunk);
        },
        (meta, kind) => {
          watchdog.touch();
          observer.callbacks.onMeta(meta, kind);
        },
        (ev) => {
          watchdog.touch();
          observer.callbacks.onTool(ev);
        },
        (phase) => {
          watchdog.touch();
          observer.callbacks.onPhase(phase);
        },
        (reasoning) => {
          watchdog.touch();
          observer.callbacks.onReasoning(reasoning);
        },
      );
      const timeoutReason = watchdog.message();
      if (timeoutReason) {
        observer.finish(
          "failed",
          result.iterationCount ?? 0,
          result.text,
          timeoutReason,
          resultUsage(result),
        );
        return { success: false, output: timeoutReason };
      }
      if (!result.success) {
        let output = formatSubagentFailure(String(result.error), result.text, expertTag, expertModel ?? ctx.config.model);
        const scopeReq = scopeCollector.toScopeRequest();
        if (scopeReq) output += `\n${formatScopeRequest(scopeReq)}`;
        observer.finish(
          resultStatus(result),
          result.iterationCount ?? 0,
          result.text,
          result.error === undefined ? undefined : String(result.error),
          resultUsage(result),
        );
        return { success: false, output };
      }

      return finalizeSubagentSuccess(result, args, ctx, observer);
    } catch (err) {
      const error = watchdog.message() ?? (err instanceof Error ? err.message : String(err));
      observer.finish("failed", 0, undefined, error);
      throw watchdog.message() ? new Error(error) : err;
    } finally {
      watchdog.dispose();
      parentSignal?.removeEventListener("abort", onParentAbort);
      ctx.subagentRuns?.releaseInterrupt?.(observer.runId);
      // Рестор точного скоупа родителя (compare-and-restore).
      restoreScope();
      if (ctx.cleanup === cleanupRun) ctx.cleanup = undefined;
      ctx.recursionDepth = currentDepth;
      executor?.setRecursionDepth?.(currentDepth);
    }
  } catch (e: any) {
    return { success: false, output: t("tool.subagent_error", { error: e.message }) };
  }
}
