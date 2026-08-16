/**
 * Plan reading + broadcasting for the trace-server side panel.
 *
 * Plans are read straight from the on-disk plan store at
 * <project>/.mma/plans/ (active.json, drafts/*.json, archive/*.json) — no
 * core changes needed. A 2s poll detects changes; plan/todo tool calls and
 * session start trigger an immediate refresh.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { state, broadcast } from "./state";
import type { PlanHistoryEntry } from "./state";

/** Duck-typed against src/modules/execution/planner.ts Plan (disk format). */
export interface PlanLike {
  id?: string;
  name?: string;
  title?: string;
  createdAt?: string;
  steps: Array<{
    id: number;
    description: string;
    status: string;
    kind?: string;
    subtasks?: Array<{ id: number; text: string; done: boolean }>;
  }>;
}

export interface PlansSnapshot {
  active: PlanLike | null;
  drafts: PlanLike[];
  archived: PlanLike[];
}

function planStepIcon(step: { status: string }): string {
  switch (step.status) {
    case "done": return "✓";
    case "failed": return "✗";
    case "skipped": return "−";
    default: return "○";
  }
}

function renderPlan(plan: PlanLike): string {
  const steps = (plan.steps || [])
    .map((s) => {
      const kind = s.kind === "delete" ? " [delete]" : "";
      const subs = (s.subtasks || [])
        .map((st) => `    ${st.done ? "✓" : "○"} ${st.text}`)
        .join("\n");
      return `  ${planStepIcon(s)} ${s.description}${kind}${subs ? "\n" + subs : ""}`;
    })
    .join("\n");
  const done = (plan.steps || []).filter((s) => s.status === "done").length;
  return `${plan.title || "Untitled plan"} (${done}/${plan.steps.length})\n${steps}`;
}

function planKey(plans: PlansSnapshot): string {
  return JSON.stringify({ active: plans.active, drafts: plans.drafts, archived: plans.archived });
}

function readPlanFile(path: string): PlanLike | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || !Array.isArray(raw.steps)) return null;
    return raw as PlanLike;
  } catch {
    return null;
  }
}

function listPlans(dir: string): PlanLike[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readPlanFile(join(dir, f)))
      .filter((p): p is PlanLike => p !== null)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  } catch {
    return [];
  }
}

export function readPlans(): PlansSnapshot {
  if (!state.projectDir) return { active: null, drafts: [], archived: [] };
  const plansDir = join(state.projectDir, ".mma", "plans");
  return {
    active: readPlanFile(join(plansDir, "active.json")),
    drafts: listPlans(join(plansDir, "drafts")),
    archived: listPlans(join(plansDir, "archive")),
  };
}

function planSummary(plan: PlanLike | null): { done: number; total: number; title: string } {
  if (!plan) return { done: 0, total: 0, title: "" };
  const steps = plan.steps || [];
  return {
    done: steps.filter((s) => s.status === "done").length,
    total: steps.length,
    title: plan.title || "Untitled plan",
  };
}

function pushPlanHistory(kind: string, plans: PlansSnapshot): void {
  const a = planSummary(plans.active);
  const entry: PlanHistoryEntry = {
    ts: Date.now(),
    kind,
    title: a.title,
    done: a.done,
    total: a.total,
    detail: [
      a.total ? `active: ${a.title} (${a.done}/${a.total})` : "active: none",
      plans.drafts.length ? `drafts: ${plans.drafts.length}` : "",
      plans.archived.length ? `archived: ${plans.archived.length}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
  state.planHistory = [entry, ...state.planHistory].slice(0, 200);
}

export function emitPlans(kind: string): void {
  const plans = readPlans();
  const key = planKey(plans);
  if (key === state.lastPlansKey) return;
  state.lastPlansKey = key;
  pushPlanHistory(kind, plans);
  broadcast({
    type: "plans",
    ts: Date.now(),
    kind,
    active: plans.active,
    drafts: plans.drafts,
    archived: plans.archived,
    history: state.planHistory.slice(0, 100),
  });
}

export function startPlanPolling(): void {
  if (state.planTimer) clearInterval(state.planTimer);
  state.planTimer = setInterval(() => emitPlans("poll"), 2000);
}

export function stopPlanPolling(): void {
  if (state.planTimer) {
    clearInterval(state.planTimer);
    state.planTimer = null;
  }
}