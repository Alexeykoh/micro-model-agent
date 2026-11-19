// Тулы плагина `angular11`. F2 — `angular_check` (разбор воркспейса),
// F4 — `angular_scaffold` (генерация каркаса).
//
// Ядро переименует тулы в `plugin__angular11__<tool>` и добавит тег
// `plugin:angular11`; здесь только определения. Enforcement путей — в
// `ToolExecutor` по `security`, хендлер политику не реализует.
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import type { ToolContext, ToolDefinition, ToolResult } from "../../../../tools/types";
import { analyzeWorkspace, type Analysis } from "./analyze";
import { isAngularProject } from "./detect";
import { type ScaffoldKind, normaliseName, scaffoldFiles } from "./scaffold";

const MAX_FINDINGS = 40;
const SCAFFOLD_KINDS: ScaffoldKind[] = [
  "component",
  "pipe",
  "module",
  "service",
  "directive",
  "guard",
];

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

/** Определение `angular_check`. */
function angularCheckTool(): ToolDefinition {
  return {
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
  };
}

/** Определение `angular_scaffold`. */
function angularScaffoldTool(): ToolDefinition {
  return {
    name: "angular_scaffold",
    description:
      "Generate classic Angular 11 (NgModule-era) boilerplate for a component, pipe, module, " +
      "service, directive or guard. Writes files only — it does NOT wire them into an NgModule; " +
      "add the declaration/import yourself after reviewing the diff.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: SCAFFOLD_KINDS },
        name: { type: "string", description: "e.g. 'user-card' or 'UserCard'." },
        path: {
          type: "string",
          description: "Target directory relative to the workspace root (default 'src/app').",
        },
        force: {
          type: "boolean",
          description: "Overwrite existing files (default false).",
        },
      },
      required: ["kind", "name"],
    },
    security: { caps: [{ fs: "write" }], pathArgs: ["path"] },
    boundedOutput: true,
    handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
      if (!isAngularProject(ctx.baseDir)) {
        return {
          success: false,
          output: "angular_scaffold: not inside an Angular workspace (no angular.json found).",
        };
      }

      const kind = String(args.kind ?? "") as ScaffoldKind;
      if (!SCAFFOLD_KINDS.includes(kind)) {
        return {
          success: false,
          output: `angular_scaffold: unknown kind '${String(args.kind ?? "")}'. Expected one of: ${SCAFFOLD_KINDS.join(", ")}.`,
        };
      }

      const names = normaliseName(String(args.name ?? ""));
      if (!names) {
        return {
          success: false,
          output: "angular_scaffold: invalid name — pass something like 'user-card'.",
        };
      }

      const dir = String(args.path ?? "src/app");
      const force = args.force === true;
      const files = scaffoldFiles(kind, names);
      const targetDir = resolve(ctx.baseDir, dir);

      const existing = Object.keys(files).filter((rel) => existsSync(join(targetDir, rel)));
      if (existing.length > 0 && !force) {
        return {
          success: false,
          output: `angular_scaffold: refusing to overwrite existing file(s): ${existing.join(", ")}. Re-run with force:true to overwrite.`,
        };
      }

      const written: string[] = [];
      for (const [rel, content] of Object.entries(files)) {
        const full = join(targetDir, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, "utf-8");
        written.push(relative(ctx.baseDir, full).replace(/\\/g, "/"));
      }

      const needsDeclaration = kind === "component" || kind === "pipe" || kind === "directive";
      const next = needsDeclaration
        ? `\n\nNext: declare ${names.className}${kind[0].toUpperCase()}${kind.slice(1)} in the NgModule that uses it (\`declarations\`), and import \`CommonModule\` if its template uses *ngIf/*ngFor.`
        : `\n\nNext: import the generated ${kind} where it is used (AppModule or a feature module).`;

      return {
        success: true,
        output: `Created:\n${written.map((w) => `- ${w}`).join("\n")}${next}`,
      };
    },
  };
}

/** Определения тулов плагина. */
export function angularTools(): ToolDefinition[] {
  return [angularCheckTool(), angularScaffoldTool()];
}
