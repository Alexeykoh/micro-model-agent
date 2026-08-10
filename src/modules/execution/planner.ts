export type StepStatus =
  "pending" | "in_progress" | "done" | "failed" | "skipped";

export interface PlanStep {
  id: number;
  description: string;
  status: StepStatus;
  note?: string;
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

export class PlanCreator {
  static isMultiStep(task: string): boolean {
    const fileCount = (task.match(/\b[\w./-]+\.[a-z]+\b/gi) || []).length;
    if (fileCount > 1) return true;

    const actionWords = [
      "implement",
      "create",
      "add",
      "build",
      "setup",
      "configure",
      "write",
      "make",
      "develop",
    ];
    const words = task.split(/\s+/);
    const hasActionWord = actionWords.some((w) =>
      task.toLowerCase().includes(w),
    );

    return hasActionWord && words.length > 8;
  }

  static createPlan(
    title: string,
    stepDescriptions: string[],
    baseDir: string,
  ): Plan {
    const stepCount = stepDescriptions.length;
    return {
      id: generatePlanId(),
      title: `[${stepCount}] ${title}`,
      steps: stepDescriptions.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: "pending" as StepStatus,
      })),
      createdAt: new Date().toISOString(),
      baseDir,
    };
  }

  static replan(plan: Plan, newSteps: string[], title?: string): Plan {
    const kept = plan.steps.filter(
      (s) => s.status === "done" || s.status === "skipped",
    );
    const baseTitle = plan.title.replace(/^\[\d+[^]]*\]\s*/, "");
    const newTitle = title || baseTitle;
    const totalSteps = kept.length + newSteps.length;
    const added: PlanStep[] = newSteps.map((desc, i) => ({
      id: kept.length + i + 1,
      description: desc,
      status: "pending" as StepStatus,
    }));
    return {
      id: plan.id,
      title: `[${totalSteps}] ${newTitle}`,
      steps: [...kept, ...added],
      createdAt: plan.createdAt,
      baseDir: plan.baseDir,
      name: plan.name,
    };
  }

  static toPromptBlock(plan: Plan, currentStepIndex: number): string {
    const date = plan.createdAt.slice(0, 10);
    const lines: string[] = [
      `[${plan.id}] ${plan.title}`,
      `Dir: ${plan.baseDir}`,
      `Created: ${date} | Progress: ${plan.steps.filter((s) => s.status === "done").length}/${plan.steps.length} done, current: step ${currentStepIndex + 1}`,
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
    }
    return lines.join("\n");
  }
}
