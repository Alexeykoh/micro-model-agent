/** Успешный финал прогона субагента: файл-артефакт или текст в контекст. */
import { t } from "../i18n/index";
import type { AgentResult } from "../core/types";
import type { ToolContext, ToolResult } from "./types";
import { ArtifactStore } from "../modules/artifacts/store";
import { resultUsage, type SubagentObserver } from "./subagent-observer";

/** Выдаёт результат в выбранном `result_mode` и закрывает observer как `done`. */
export function finalizeSubagentSuccess(
  result: AgentResult,
  args: Record<string, unknown>,
  ctx: ToolContext,
  observer: SubagentObserver,
): ToolResult {
  const resultMode = (args.result_mode as string) || ctx.config.subagent?.resultMode || "text";
  const usage = resultUsage(result);
  const iterations = result.iterationCount ?? 0;

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
      `subagent result persisted to artifact ${abs} (${result.text.length} chars, ${iterations} iterations)`,
    );
    observer.finish("done", iterations, result.text, undefined, usage);
    return {
      success: true,
      output: t("tool.subagent_artifact", {
        path: abs,
        iterations: String(iterations),
        summary,
      }),
      artifactPath: abs,
      usage,
    };
  }

  observer.finish("done", iterations, result.text, undefined, usage);
  return {
    success: true,
    output: t("tool.subagent_completed", {
      text: result.text,
      iterations: String(iterations),
    }),
    usage,
  };
}
