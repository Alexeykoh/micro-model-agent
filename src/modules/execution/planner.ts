export type StepStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export interface Subtask {
  id: number;
  text: string;
  done: boolean;
}

export type StepKind = "create" | "delete";

export interface PlanStep {
  id: number;
  description: string;
  status: StepStatus;
  /** Model-declared intent. "delete" inverts the deliverable gate: named
   *  files must be GONE, not present. Default "create". */
  kind?: StepKind;
  note?: string;
  subtasks?: Subtask[];
}

export interface Plan {
  id: string;
  title: string;
  steps: PlanStep[];
  createdAt: string;
  baseDir: string;
  name?: string;
}

function generatePlanId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `plan_${id}`;
}

/**
 * Single source of truth for plan progress counting (ses_mt4fn58c: `show`
 * said "6/7 done, complete" while `list` said "7/7" for the same plan —
 * one counted only "done", the other counted done+skipped). A skipped step
 * needs no further work, so it counts as settled everywhere.
 */
export function getPlanProgress(plan: Plan): {
  done: number;
  skipped: number;
  total: number;
  settled: number;
  terminal: boolean;
} {
  const done = plan.steps.filter((s) => s.status === "done").length;
  const skipped = plan.steps.filter((s) => s.status === "skipped").length;
  const total = plan.steps.length;
  const settled = done + skipped;
  return { done, skipped, total, settled, terminal: total > 0 && settled === total };
}

export class PlanCreator {
  static createPlan(
    title: string,
    stepDescriptions: string[],
    baseDir: string,
    kinds?: StepKind[],
  ): Plan {
    const stepCount = stepDescriptions.length;
    return {
      id: generatePlanId(),
      title: `[${stepCount}] ${title}`,
      steps: stepDescriptions.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: "pending" as StepStatus,
        kind: kinds?.[i] ?? "create",
      })),
      createdAt: new Date().toISOString(),
      baseDir,
    };
  }

  static replan(plan: Plan, newSteps: string[], title?: string): Plan {
    const kept = plan.steps.filter((s) => s.status === "done" || s.status === "skipped");
    const baseTitle = plan.title.replace(/^\[\d+[^]]*\]\s*/, "");
    const newTitle = title || baseTitle;
    const totalSteps = kept.length + newSteps.length;
    const added: PlanStep[] = newSteps.map((desc) => ({
      id: -1, // renumbered below
      description: desc,
      status: "pending" as StepStatus,
      kind: "create",
    }));
    // Renumber every step (kept + added) sequentially. Kept steps keep their
    // status and kind but may collide with the added ids when the original
    // plan skipped/pending steps in the middle (e.g. done 1, done 3 → kept
    // [1,3], added [2…] collides with kept id 3).
    const steps = [...kept, ...added].map((s, i) => ({ ...s, id: i + 1 }));
    return {
      id: plan.id,
      title: `[${totalSteps}] ${newTitle}`,
      steps,
      createdAt: plan.createdAt,
      baseDir: plan.baseDir,
      name: plan.name,
    };
  }

  static toPromptBlock(plan: Plan, currentStepIndex: number): string {
    const date = plan.createdAt.slice(0, 10);
    const p = getPlanProgress(plan);
    const skippedPart = p.skipped > 0 ? `, ${p.skipped} skipped` : "";
    const progress = p.terminal
      ? `${p.settled}/${p.total} done${skippedPart}, complete`
      : `${p.settled}/${p.total} done${skippedPart}, current: step ${currentStepIndex + 1}`;
    const lines: string[] = [
      `[${plan.id}] ${plan.title}`,
      `Dir: ${plan.baseDir}`,
      `Created: ${date} | Progress: ${progress}`,
      ``,
    ];
    for (const step of plan.steps) {
      const icon =
        step.status === "done"
          ? "[x]"
          : step.status === "in_progress"
            ? "[*]"
            : step.status === "failed"
              ? "[!]"
              : step.status === "skipped"
                ? "[-]"
                : "[ ]";
      const note = step.note ? ` — ${step.note}` : "";
      lines.push(`${icon} ${step.id}. ${step.description}${note}`);
      for (const sub of step.subtasks ?? []) {
        lines.push(`    ${sub.done ? "[x]" : "[ ]"} ${sub.text}`);
      }
    }
    return lines.join("\n");
  }
}
