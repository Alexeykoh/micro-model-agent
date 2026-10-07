/** Тул изолированного субагента (свой контекст, скоуп, теги тулов, MoE-off). */
import { t } from "../i18n/index";
import type { ToolDefinition, ToolContext, ToolScope } from "./types";
import { Agent } from "../core/agent";
import { ContextManager } from "../modules/context/manager";
import { HallucinationDetector } from "../modules/hallucination/detector";
import { PluginManager } from "../modules/plugins/manager";
import type { PromptBlock } from "../core/types";
import { logSecurityBlock } from "../modules/security/audit-log";
import { getSessionSecurityConfig } from "../modules/security/session-isolation";
import { ArtifactStore } from "../modules/artifacts/store";
import { ScopeDenialCollector, formatScopeRequest } from "./scope-request";
import { getExpertConfig } from "../config/experts";

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

/** Спавнит изолированного субагента. Параметры: task, scope-файлы, tool_tags, result_mode. */
export const subagentTool: ToolDefinition = {
  name: "subagent",
  icon: "🤖",
  description:
    "Spawn an isolated sub-agent to work on a task independently. The sub-agent has its own context and executes autonomously. Use for parallel work or complex sub-tasks.",
  tags: ["code"],
  // Несколько subagent-вызовов одного хода выполняются конкурентно
  // (ToolBatchExecutor запускает их через fork'и, см. tool-batch.ts).
  parallelizable: true,
  timeoutMs: (ctx) => ctx.config?.subagent?.timeoutMs ?? 180000,
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Task description for the sub-agent",
      },
      context: {
        type: "string",
        description: "Optional context or constraints",
      },
      expert_tag: {
        type: "string",
        description:
          "Configured expert tag (from config.experts) — derives the sub-agent's tool_tags. Ignored if tool_tags is given.",
      },
      allowed_files: {
        type: "array",
        items: { type: "string" },
        description: "Files/directories the sub-agent can read and write",
      },
      read_only_files: {
        type: "array",
        items: { type: "string" },
        description: "Files/directories the sub-agent can read but not write",
      },
      shared_context: {
        type: "string",
        description: "Shared context/rules passed to the sub-agent",
      },
      max_tokens: {
        type: "number",
        description: "Maximum tokens for the sub-agent response",
      },
      tool_tags: {
        type: "array",
        items: { type: "string" },
        description: "Tool tags to expose to the sub-agent",
      },
      result_mode: {
        type: "string",
        enum: ["text", "file"],
        description:
          '"file": persist the full result to an artifact and return a path + summary (pass-by-reference). "text" (default): return the full text into context.',
      },
      artifact_name: {
        type: "string",
        description: "Artifact file name (sanitized). Default: subagent-<timestamp>.",
      },
    },
    required: ["task"],
  },
  handler: async (ctx: ToolContext, args) => {
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
    // (его видят вложенные субагенты) — `ctx.recursionDepth` снапшотился раз при
    // bootstrap и не инкрементился, поэтому гард не срабатывал и субагент мог
    // спавнить субагентов безгранично.
    const executor = ctx.toolExecutor;
    const parentDepth =
      executor?.getRecursionDepth?.() ?? (ctx.recursionDepth ?? 0);
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
    // сконфигурированного эксперта. Раньше параметр молча игнорировался, и
    // модель, передав expert_tag, получала дефолтный набор (наблюдалось:
    // expert_tag:"web" → ноль фильтрации → сабтаск ушёл в таймаут).
    let toolTags = explicitTags;
    if ((!toolTags || toolTags.length === 0) && expertTag) {
      const expert = getExpertConfig(ctx.config, expertTag);
      if (!expert) {
        const known = Object.keys(ctx.config.experts ?? {});
        return {
          success: false,
          output: `[SECURITY BLOCKED] Unknown expert_tag "${expertTag}". Known experts: [${known.join(", ") || "none"}]. Pass a configured expert tag or explicit tool_tags.`,
        };
      }
      toolTags = expert.tool_tags;
    }

    if (!ctx.llmProvider || !ctx.toolExecutor) {
      return {
        success: false,
        output: t("tool.subagent_cannot_run"),
      };
    }

    // Оборонительный гард: запрошенные tool_tags ни с чем не мэтчатся — у
    // субагента ноль тулов, и он галлюцинирует вместо действий. Предупредить
    // вызывающего для коррекции тегов. Проверка через getByTags (не
    // getAllForLLM): alwaysOn мэтчатся всегда — гард меряет реальное покрытие,
    // а не присутствие в схеме.
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
    // родителя навсегда. Текущий скоуп — из shared-исполнителя, не `ctx.scope`:
    // MoE зовёт тул с ad-hoc контекстом без scope — снапшот `ctx.scope` ресторил
    // бы "unrestricted" и сносил изоляцию всей волне.
    const parentScope = executor?.getScope?.() ?? ctx.scope;
    const appliedScope = scope || { allowed_files: [], read_only_files: [] };
    // Compare-and-restore: параллельная MoE-волна могла тем временем поставить
    // свой скоуп — чужого свежего владельца не затирать.
    const restoreScope = () => {
      if (ctx.toolExecutor?.getScope?.() === appliedScope) {
        ctx.toolExecutor.setScope(parentScope);
      }
    };

    try {
      const subContextManager = new ContextManager(
        ctx.config.contextWindow,
        ctx.config.contextBudget,
      );
      const subPluginManager = new PluginManager();
      // Детерминированный трекинг scope-отказов: блокировки файловых тулов
      // ребёнка скоуп-гардом всплывают машиночитаемым блоком <scope-request>
      // в результате (см. MoE executor / Router).
      const scopeCollector = new ScopeDenialCollector();
      subPluginManager.register(scopeCollector.plugin, "builtin");
      const hallucinationDetector = new HallucinationDetector(ctx.baseDir, ctx.llmProvider);

      ctx.toolExecutor.setScope(appliedScope);
      // Cleanup на исполнителе — рестор скоупа при таймауте/аборте, даже если
      // `finally` агента не отработал (брошенный промис).
      ctx.cleanup = restoreScope;
      // Глубину — на shared-контекст исполнителя, чтобы ВЛОЖЕННЫЕ субагенты
      // видели уровень глубже (и гард выше мог сработать).
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

      // MoE — TOP-LEVEL режим оркестрации: субагент от тула subagent всегда идёт
      // plain single-agent циклом. Шаринг родительского конфига заставлял каждого
      // MoE-субагента реентерить runWithMoE — планировать свои сабтаски и рекурсивно
      // спавнить вложенных субагентов (лимит — лишь maxRecursionDepth), что вешало
      // исполнение на минуты без прогресс-событий.
      const subConfig = { ...ctx.config, moe: { ...ctx.config.moe, enabled: false } };

      const subDeps = {
        config: subConfig,
        llmProvider: ctx.llmProvider,
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
            // Структурированный путь, чтобы вызывающие (MoE executor) не парсили
            // локализованную строку `output`.
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
        // Рестор точного скоупа родителя (compare-and-restore — свежий скоуп
        // параллельного сиблинга не затирать). undefined — "без ограничений",
        // пустым скоупом (запрет всего) становиться не должен.
        restoreScope();
        if (ctx.cleanup === restoreScope) ctx.cleanup = undefined;
        ctx.recursionDepth = currentDepth;
        executor?.setRecursionDepth?.(currentDepth);
      }
    } catch (e: any) {
      return { success: false, output: t("tool.subagent_error", { error: e.message }) };
    }
  },
};
