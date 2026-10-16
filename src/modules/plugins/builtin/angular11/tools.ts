// Тулы плагина `angular11`. F2 — `angular_check`: архитектурный разбор воркспейса.
//
// Ядро переименует тул в `plugin__angular11__angular_check` и добавит тег
// `plugin:angular11`; здесь только определение. Enforcement путей — в
// `ToolExecutor` по `security`, хендлер политику не реализует.
import type { ToolContext, ToolDefinition, ToolResult } from "../../../../tools/types";
import { analyzeWorkspace, type Analysis } from "./analyze";

const MAX_FINDINGS = 40;

/** Человекочитаемая сводка анализа для модели. */
export function formatAnalysis(a: Analysis): string {
  const lines: string[] = [];
  lines.push(`Angular check — ${a.root}`);
  lines.push(`@angular/core: ${a.major === null ? "unknown" : `v${a.major}`}`);
  lines.push(
    `Modules: ${a.modules.length}; components/directives/pipes: ${a.classes.length}`,
  );

  const findings = [...a.findings].sort((x, y) =>
    x.severity === y.severity ? 0 : x.severity === "error" ? -1 : 1,
  );

  if (a.major !== null && a.major !== 11) {
    lines.push(
      `\n[warn] this project uses Angular ${a.major}; the angular11 plugin targets the classic NgModule era (11) — some advice may not apply`,
    );
  }

  if (findings.length === 0) {
    lines.push("\nNo structural issues found.");
    return lines.join("\n");
  }

  lines.push("\nFindings:");
  for (const finding of findings.slice(0, MAX_FINDINGS)) {
    lines.push(`- [${finding.severity}] ${finding.message}`);
  }
  if (findings.length > MAX_FINDINGS) {
    lines.push(`- … and ${findings.length - MAX_FINDINGS} more`);
  }
  return lines.join("\n");
}

/** Определения тулов плагина. */
export function angularTools(): ToolDefinition[] {
  return [
    {
      name: "angular_check",
      description:
        "Analyze an Angular workspace for classic-NgModule (v11) structure: module declarations, " +
        "missing CommonModule in feature modules, BrowserModule in lazy modules, undeclared " +
        "components/pipes/directives, impure pipes. Use it before/after adding components or modules.",
      parameters: { type: "object", properties: {}, required: [] },
      security: { caps: [{ fs: "read" }] },
      boundedOutput: true,
      cacheable: true,
      handler: async (ctx: ToolContext): Promise<ToolResult> => {
        const analysis = analyzeWorkspace(ctx.baseDir);
        return { success: true, output: formatAnalysis(analysis) };
      },
    },
  ];
}
