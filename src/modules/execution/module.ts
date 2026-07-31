import type { AgentModule } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition } from "../../tools/types";
import type { AgentPlugin } from "../types";
import { t } from "../../i18n/index";
import { PlanCreator } from "./planner";
import { PlanTracker } from "./tracker";
import { StepVerifier } from "./verifier";
import { StuckDetector } from "./stuck-detector";
import { Auditor } from "./auditor";
import type { Plan } from "./planner";
import { existsSync } from "fs";
import { resolve } from "path";

const STUCK_RECOVERY_COOLDOWN = 5;

export class ExecutionModule implements AgentModule {
  name = "execution";
  private tracker: PlanTracker | null = null;
  private verifier: StepVerifier;
  private stuckDetector: StuckDetector;
  private auditor: Auditor;
  private baseDir: string;
  private lastRecoveryIteration = -STUCK_RECOVERY_COOLDOWN;

  constructor(baseDir: string, stuckThreshold = 8) {
    this.baseDir = baseDir;
    this.verifier = new StepVerifier(baseDir);
    this.stuckDetector = new StuckDetector(stuckThreshold);
    this.auditor = new Auditor(baseDir);
  }

  setPlan(plan: Plan): void {
    this.tracker = new PlanTracker(plan);
  }

  getTracker(): PlanTracker | null {
    return this.tracker;
  }

  getStuckDetector(): StuckDetector {
    return this.stuckDetector;
  }

  getSystemPromptBlock(): PromptBlock | null {
    if (!this.tracker) return null;
    return {
      content: this.tracker.toPromptBlock(),
      priority: "critical",
      essential: true,
      estimatedTokens: 200,
    };
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "plan",
        description:
          'Create, update, or abort a multi-step plan. Use "create" at the start of complex tasks. Use "update" after completing each step to track progress.',
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "update", "abort"] },
            title: { type: "string" },
            steps: { type: "array", items: { type: "string" } },
            step: { type: "number" },
            status: { type: "string", enum: ["done", "failed", "skipped"] },
            note: { type: "string" },
          },
          required: ["action"],
        },
        handler: async (_ctx, args) => {
          const action = String(args.action);
          if (action === "create") {
            const title = String(args.title || "Task Plan");
            const steps = Array.isArray(args.steps)
              ? args.steps.map(String)
              : [];
            if (steps.length === 0) {
              return { success: false, output: t("plan.no_steps") };
            }
            const plan = PlanCreator.createPlan(title, steps);
            this.setPlan(plan);
            const display = PlanCreator.toPromptBlock(plan, 0);
            return {
              success: true,
              output: t("plan.created", { title, steps: String(steps.length) }),
              display,
            };
          }
          if (action === "update" && args.step && this.tracker) {
            this.tracker.updateStepStatus(
              Number(args.step),
              (args.status as any) || "done",
            );
            if (args.note)
              this.tracker.addNote(Number(args.step), String(args.note));
            const progress = this.tracker.getProgressString();
            const display = this.tracker.toPromptBlock();
            return {
              success: true,
              output: `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })}\n${progress}`,
              display,
            };
          }
          if (action === "abort") {
            this.tracker = null;
            return { success: true, output: t("plan.aborted") };
          }
          if (!this.tracker) {
            return { success: false, output: t("plan.no_active") };
          }
          return {
            success: false,
            output: t("plan.unknown_action", { action }),
          };
        },
      },
      {
        name: "todo",
        description:
          "Manage sub-tasks within current plan step. Use to break down complex steps into smaller tasks.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "done", "list"] },
            items: { type: "array", items: { type: "string" } },
          },
          required: ["action"],
        },
        handler: async (_ctx, args) => {
          if (!this.tracker) {
            return { success: false, output: t("plan.no_active") };
          }
          const action = String(args.action);
          const currentStep = this.tracker.getCurrentStep();
          if (!currentStep) {
            return { success: false, output: t("plan.step_not_found") };
          }
          if (action === "add" && Array.isArray(args.items)) {
            const items = args.items.map(String);
            currentStep.note = currentStep.note
              ? `${currentStep.note}; ${items.join(", ")}`
              : items.join(", ");
            return {
              success: true,
              output: t("todo.added", {
                count: String(items.length),
                items: items.join(", "),
              }),
            };
          }
          if (action === "done") {
            return {
              success: true,
              output: t("todo.marked_done", { count: "1" }),
            };
          }
          if (action === "list") {
            const note = currentStep.note || "(no sub-tasks)";
            return {
              success: true,
              output: `Step ${currentStep.id}: ${currentStep.description}\nSub-tasks: ${note}`,
            };
          }
          return {
            success: false,
            output: t("todo.unknown_action", { action }),
          };
        },
      },
      {
        name: "verify",
        description:
          "Run verification for the current step. Checks files mentioned in the step description.",
        parameters: {
          type: "object",
          properties: {
            step: { type: "number", description: "Step number to verify" },
          },
        },
        handler: async (_ctx, args) => {
          if (!this.tracker)
            return { success: false, output: t("plan.no_active") };
          const step = args.step
            ? this.tracker.getStep(Number(args.step))
            : this.tracker.getCurrentStep();
          if (!step)
            return { success: false, output: t("plan.step_not_found") };
          const result = await this.verifier.verifyStep(step.description);
          return {
            success: result.passed,
            output: result.passed
              ? t("verify.passed")
              : t("verify.failed", {
                  details: result.failed.map((f) => f.message).join("; "),
                }),
          };
        },
      },
    ];
  }

  getPlugin(): AgentPlugin {
    return {
      name: "execution",
      onBeforeThink: (ctx: any) => {
        const currentStepId = this.tracker
          ? (this.tracker.getCurrentStep()?.id ?? 0)
          : 0;
        this.stuckDetector.recordIteration(currentStepId);
        if (this.tracker) {
          const step = this.tracker.getCurrentStep();
          if (step)
            this.stuckDetector.setCurrentStep(step.id, step.description);
        }
        const stuckReason = this.stuckDetector.getStuckReason();
        if (stuckReason) {
          ctx.logger?.warn(stuckReason);
        }
        if (
          this.stuckDetector.isStuck() ||
          this.stuckDetector.hasRepetitiveToolCalls()
        ) {
          const currentIter =
            typeof ctx.iteration === "number" ? ctx.iteration : 0;
          if (
            currentIter - this.lastRecoveryIteration >=
            STUCK_RECOVERY_COOLDOWN
          ) {
            const recovery = this.stuckDetector.getRecoveryMessage();
            if (recovery && ctx.contextManager) {
              ctx.contextManager.addMessage({
                role: "user",
                content: `<system-summary>${recovery}</system-summary>`,
              });
            }
            this.lastRecoveryIteration = currentIter;
          }
        }
      },
      onBeforeTool: (ctx: any, call: any) => {
        const warning = this.checkPlanAlignment(call);
        if (warning && ctx.contextManager) {
          ctx.contextManager.addMessage({
            role: "user",
            content: `<system-summary>${warning}</system-summary>`,
          });
        }
        return true;
      },
      onToolCall: (ctx: any) => {
        const toolName = ctx?.toolName as string;
        const args = ctx?.args as Record<string, unknown>;
        if (toolName && args) {
          this.stuckDetector.recordToolCall(toolName, args);
        }
      },
      onAfterTool: (ctx: any, call: any, result: any) => {
        if (!result.success) {
          this.stuckDetector.recordToolError("tool");
        }
        if (
          this.tracker &&
          result.success &&
          (call.name === "write_file" || call.name === "edit_file")
        ) {
          this.advancePlanIfStepComplete();
        }
      },
    };
  }

  private checkPlanAlignment(call: any): string | null {
    if (!this.tracker) return null;
    const step = this.tracker.getCurrentStep();
    if (!step) return null;

    const allowedAlways = [
      "plan",
      "todo",
      "verify",
      "list_dir",
      "read_file",
      "glob",
      "grep",
      "file_info",
      "load_skill",
      "question",
      "approve",
    ];
    if (allowedAlways.includes(call.name)) return null;

    const stepPaths = (
      step.description.match(/\b[\w./\\-]+\.[a-z]+/gi) || []
    ).map((p) => p.toLowerCase());
    if (stepPaths.length === 0) return null;

    const argStr = JSON.stringify(call.arguments).toLowerCase();
    const callPaths = (argStr.match(/\b[\w./\\-]+\.[a-z]+/gi) || []).map((p) =>
      p.toLowerCase(),
    );

    if (callPaths.length === 0) return null;

    const offPath = callPaths.some(
      (p) => !stepPaths.some((s) => p.includes(s) || s.includes(p)),
    );
    if (!offPath) return null;

    return t("exec.plan_warning", {
      step: String(step.id),
      description: step.description,
      tool: call.name,
    });
  }

  private advancePlanIfStepComplete(): void {
    const step = this.tracker?.getCurrentStep();
    if (!step) return;
    const stepPaths = step.description.match(/\b[\w./\\-]+\.[a-z]+/gi) || [];
    if (stepPaths.length === 0) return;

    const allExist = stepPaths.every((p) =>
      existsSync(resolve(this.baseDir, p)),
    );

    if (allExist) {
      this.tracker?.updateStepStatus(step.id, "done");
      this.tracker?.advance();
    }
  }
}
