import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pc } from "./colors";
import { glyph } from "./theme";
import type { Plan, PlanStep } from "../modules/execution/planner";
import { extractFileLikeTokens, stripUrls } from "../modules/hallucination/js-identifiers";
import { t } from "../i18n/index";
import { projectMmaDir } from "../config/paths";

export function readActivePlan(baseDir: string): Plan | null {
  const p = join(projectMmaDir(baseDir), "plans", "active.json");
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    return {
      id: parsed.id || "plan",
      title: parsed.title || "Plan",
      steps: parsed.steps,
      createdAt: parsed.createdAt || new Date().toISOString(),
      baseDir: parsed.baseDir || baseDir,
      name: parsed.name,
    };
  } catch {
    return null;
  }
}

export function currentStepIndex(plan: Plan): number {
  return plan.steps.findIndex((s) => s.status !== "done" && s.status !== "skipped");
}

function stepMark(step: PlanStep): string {
  switch (step.status) {
    case "done":
      return pc.green(glyph.success);
    case "in_progress":
      return pc.cyan(glyph.action);
    case "failed":
      return pc.red(glyph.failure);
    case "skipped":
      return pc.dim("–");
    default:
      return pc.dim("○");
  }
}

export function formatPlanChecklist(plan: Plan): string[] {
  const done = plan.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const total = plan.steps.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const cur = currentStepIndex(plan);
  const barLen = 10;
  const filled = Math.round((pct / 100) * barLen);
  const bar = pc.green("▰".repeat(filled)) + pc.dim("▱".repeat(barLen - filled));
  const title = plan.title.replace(/^\[\d+[^]]*\]\s*/, "");
  const lines: string[] = [
    `${pc.cyan(glyph.action)} ${pc.bold(title)}  ${bar} ${pc.dim(`${done}/${total}`)}`,
  ];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const active = i === cur;
    const desc = active ? pc.yellow(step.description) : pc.dim(step.description);
    lines.push(`  ${stepMark(step)} ${step.id}. ${desc}`);
    for (const sub of step.subtasks ?? []) {
      lines.push(`      ${sub.done ? pc.green(glyph.success) : pc.dim("○")} [${sub.id}] ${sub.text}`);
    }
  }
  return lines;
}

const STRUCTURAL_TOOLS = new Set([
  "plan",
  "plan_step",
  "todo",
  "verify",
  "project_map",
  "lsp_check",
  "enable_tools",
]);

function truncate(s: string, max = 48): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function stepContextForTool(
  plan: Plan | null,
  tool: string,
  args: Record<string, unknown>,
): string | null {
  if (!plan || STRUCTURAL_TOOLS.has(tool)) return null;
  const argStr = JSON.stringify(args);
  const callPaths = extractFileLikeTokens(stripUrls(argStr)).map((p) => p.toLowerCase());
  if (callPaths.length > 0) {
    for (const step of plan.steps) {
      if (step.status === "done" || step.status === "skipped") continue;
      const stepPaths = extractFileLikeTokens(stripUrls(step.description)).map((p) =>
        p.toLowerCase(),
      );
      if (
        stepPaths.length > 0 &&
        stepPaths.some((s) => callPaths.some((c) => c.includes(s) || s.includes(c)))
      ) {
        return t("ui.step_context", { id: step.id, desc: truncate(step.description) });
      }
    }
  }
  return null;
}
