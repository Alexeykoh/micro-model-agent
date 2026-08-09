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
import { PlanPersister } from "./plan-persister";
import { checkPlanCoverage } from "./plan-coverage";
import { getMessageText } from "../../llm/provider";
import type { Plan } from "./planner";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const STUCK_RECOVERY_COOLDOWN = 5;
const MAX_PLAN_WARNINGS_BEFORE_BLOCK = 3;
const FORCE_SKIP_THRESHOLD = 10;

export class ExecutionModule implements AgentModule {
  name = "execution";
  private tracker: PlanTracker | null = null;
  private verifier: StepVerifier;
  private stuckDetector: StuckDetector;
  private auditor: Auditor;
  private persister: PlanPersister;
  private baseDir: string;
  private lastRecoveryIteration = -STUCK_RECOVERY_COOLDOWN;
  private consecutivePlanWarnings = 0;
  private lastStepId = -1;
  // Skip the first audit after restoring a plan from disk — gives the user
  // one chance to change the subject before the audit gate locks in.
  private _auditSkipsRemaining = 0;

  constructor(baseDir: string, stuckThreshold = 6) {
    this.baseDir = baseDir;
    this.verifier = new StepVerifier(baseDir);
    this.stuckDetector = new StuckDetector(stuckThreshold);
    this.auditor = new Auditor(baseDir);
    this.persister = new PlanPersister(baseDir);
  }

  setPlan(plan: Plan): void {
    this.tracker = new PlanTracker(plan);
    this.persister.save(plan);
    this._auditSkipsRemaining = 0; // plan explicitly created — arm the audit gate
  }

  restorePlan(): boolean {
    const plan = this.persister.load();
    if (!plan) return false;
    this.tracker = new PlanTracker(plan);
    // Advance to the first non-done step
    this.tracker.syncCurrentStep();
    this._auditSkipsRemaining = 1; // restored plan — one free pass
    return true;
  }

  getTracker(): PlanTracker | null {
    return this.tracker;
  }

  getStuckDetector(): StuckDetector {
    return this.stuckDetector;
  }

  /**
   * Final audit before the agent may declare the task done. Returns null when
   * no plan is active; otherwise checks plan completion + artifact existence.
   */
  async runFinalAudit(): Promise<{
    passed: boolean;
    done: number;
    total: number;
    pendingSteps: string[];
    missingFiles: string[];
    summary: string;
  } | null> {
    if (!this.tracker) return null;
    if (this._auditSkipsRemaining > 0) {
      this._auditSkipsRemaining--;
      return null;
    }
    const plan = this.tracker.getPlan();
    const audit = await this.auditor.audit(plan);
    const pendingSteps = plan.steps
      .filter((s) => s.status !== "done" && s.status !== "skipped")
      .map((s) => `${s.id}. ${s.description}`);
    const done = plan.steps.filter((s) => s.status === "done").length;
    const passed = audit.passed && pendingSteps.length === 0;
    return {
      passed,
      done,
      total: plan.steps.length,
      pendingSteps,
      missingFiles: audit.missingFiles,
      summary: audit.summary,
    };
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
          'Create, update, show, or abort a multi-step plan. Use "create" at the start of complex tasks. Use "update" after completing each step to track progress. Use "show" to re-print the current plan checklist.\n\nWrite CONCRETE steps with exact file paths and commands:\n- Specify WHICH files to create with exact paths (e.g. "create src/components/Header.tsx with navigation and logo")\n- Specify WHICH packages to install (e.g. "run npm install react react-dom")\n- Specify WHICH CLI commands to run with exact arguments\n- Each step should include at least one file extension (.ts, .tsx, .json, etc.) or a command verb (install, create, build, run, add, init)\n- Good: "Создать src/components/Header.tsx с навигацией и логотипом"\n- Bad: "Настройка проекта" (too vague — what exactly needs to be configured?)',
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["create", "update", "show", "abort"],
            },
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
            const plan = PlanCreator.createPlan(title, steps, this.baseDir);
            this.setPlan(plan);
            const display = PlanCreator.toPromptBlock(plan, 0);
            let output = t("plan.created", {
              title,
              steps: String(steps.length),
            });
            let displayOut = display;
            const taskText = this.getTaskText(_ctx);
            if (taskText) {
              const { missing } = checkPlanCoverage(taskText, steps);
              if (missing.length > 0) {
                const warn = t("plan.coverage_warning", {
                  missing: missing.join(", "),
                });
                output += `\n⚠️ ${warn}`;
                displayOut = `${display}\n⚠️ ${warn}`;
              }
            }
            return {
              success: true,
              output,
              display: displayOut,
            };
          }
          if (action === "show") {
            if (!this.tracker) {
              return { success: false, output: t("plan.no_active") };
            }
            const display = this.tracker.toPromptBlock();
            return {
              success: true,
              output: `${t("plan.show_header")}\n${display}`,
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
            this.tracker.syncCurrentStep();
            this.persister.save(this.tracker.getPlan());
            const progress = this.tracker.getProgressString();
            const display = this.tracker.toPromptBlock();
            _ctx.sessionLog?.plan(
              "step-update",
              `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })} | ${progress} | current: step ${this.tracker.getCurrentStepIndex() + 1}`,
            );
            return {
              success: true,
              output: `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })}\n${progress}`,
              display,
            };
          }
          if (
            action === "update" &&
            Array.isArray(args.steps) &&
            args.steps.length > 0 &&
            this.tracker
          ) {
            const title = String(args.title || this.tracker.getPlan().title);
            const steps = args.steps.map(String);
            const plan = PlanCreator.createPlan(title, steps, this.baseDir);
            this.setPlan(plan);
            const display = PlanCreator.toPromptBlock(plan, 0);
            const output = t("plan.updated", {
              title,
              steps: String(steps.length),
            });
            return {
              success: true,
              output,
              display,
            };
          }
          if (action === "abort") {
            this.tracker = null;
            this.persister.clear();
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
            if (!currentStep) {
              return { success: false, output: t("plan.step_not_found") };
            }
            this.tracker.updateStepStatus(currentStep.id, "done");
            this.tracker.syncCurrentStep();
            this.persister.save(this.tracker.getPlan());
            const display = this.tracker.toPromptBlock();
            return {
              success: true,
              output: t("plan.step_status", {
                step: String(currentStep.id),
                status: "done",
              }),
              display,
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
        const step = this.tracker?.getCurrentStep();
        if (this.tracker && step) {
          if (step.id !== this.lastStepId) {
            this.consecutivePlanWarnings = 0;
            this.lastStepId = step.id;
          }
          this.stuckDetector.setCurrentStep(step.id, step.description);
          this.stuckDetector.recordIteration(step.id);
        } else {
          this.stuckDetector.reset();
          this.consecutivePlanWarnings = 0;
          this.lastStepId = -1;

          const iter: number =
            typeof ctx.iteration === "number" ? ctx.iteration : 0;
          if (iter === 3 && !this.tracker && ctx.contextManager) {
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>You have made 3 tool calls without creating a plan. For any task that involves creating files, installing packages, or multiple steps — you MUST use plan create BEFORE continuing. Use the plan tool now with concrete steps (exact filenames, commands, deliverables). Do NOT make any more write/edit/bash calls until you have a plan.</system-summary>`,
            });
          }
          if (iter >= 6 && !this.tracker && ctx.contextManager) {
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>STOP. ${iter} iterations without a plan. You MUST call plan create RIGHT NOW. No more tool calls until you create a plan.</system-summary>`,
            });
          }
        }
        const stuckReason = this.stuckDetector.getStuckReason();
        if (stuckReason) {
          ctx.logger?.warn(stuckReason);
          ctx.sessionLog?.plan(
            "stuck-warning",
            stuckReason,
            typeof ctx.iteration === "number" ? ctx.iteration : undefined,
          );
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
              const lastError = this.stuckDetector.getLastErrorOutput();
              const skillHint = lastError
                ? "\nIf you have relevant skills available, consider loading one with load_skill for expert guidance."
                : "";

              // Actionable hints based on actual error output
              const actionableHints = this.stuckDetector.getActionableHints();
              const actionableHintStr =
                actionableHints.length > 0
                  ? `\n${t("exec.hints", { hints: actionableHints.map((h) => `- ${h}`).join("\n") })}`
                  : "";

              // Tool alternative suggestion
              const alternative = this.stuckDetector.getToolAlternative();
              const altHint = alternative
                ? `\nTool "${this.stuckDetector.getLastFailedTool()}" is failing. Try "${alternative}" instead.`
                : "";

              ctx.contextManager.addMessage({
                role: "user",
                content: `<system-summary>${recovery}${skillHint}${actionableHintStr}${altHint}</system-summary>`,
              });
            }
            const hints = this.stuckDetector.getHints();
            if (hints.length > 0 && ctx.contextManager) {
              const hintMsg = t("exec.hints", {
                hints: hints.map((h) => `- ${h}`).join("\n"),
              });
              ctx.contextManager.addMessage({
                role: "user",
                content: `<system-summary>${hintMsg}</system-summary>`,
              });
            }
            this.stuckDetector.recordEscalation();
            this.lastRecoveryIteration = currentIter;

            if (this.stuckDetector.shouldEscalate() && ctx.onMeta) {
              const escalation = t("exec.escalation", {
                stepId: String(this.tracker?.getCurrentStep()?.id ?? "?"),
                description: this.tracker?.getCurrentStep()?.description ?? "",
              });
              ctx.onMeta(escalation);
            }

            // Force skip after too many iterations on the same step
            if (
              this.stuckDetector.getIterationsOnCurrentStep() >=
                FORCE_SKIP_THRESHOLD &&
              ctx.contextManager
            ) {
              const step = this.tracker?.getCurrentStep();
              ctx.contextManager.addMessage({
                role: "user",
                content: `<system-summary>STOP. Step ${step?.id ?? "?"} ("${step?.description ?? ""}") took ${this.stuckDetector.getIterationsOnCurrentStep()} iterations with no progress. DO NOT continue this step. Immediately call: plan update step=${step?.id ?? "?"} status=done (if code works despite warnings) OR plan update step=${step?.id ?? "?"} status=skipped note="reason". Do NOT make any other tool calls before updating the plan.</system-summary>`,
              });
            }
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
          this.consecutivePlanWarnings++;
          if (this.consecutivePlanWarnings >= MAX_PLAN_WARNINGS_BEFORE_BLOCK) {
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.plan_blocked", { step: String(this.tracker?.getCurrentStep()?.id ?? "?"), max: MAX_PLAN_WARNINGS_BEFORE_BLOCK })}</system-summary>`,
            });
            return false;
          }
        } else {
          this.consecutivePlanWarnings = 0;
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
          this.stuckDetector.recordToolError(call.name, result.output);

          // Immediately inject actionable hint on failure (don't wait for stuck threshold)
          const actionableHints = this.stuckDetector.getActionableHints();
          const alternative = this.stuckDetector.getToolAlternative();
          if (
            (actionableHints.length > 0 || alternative) &&
            ctx.contextManager
          ) {
            const parts = [...actionableHints];
            if (alternative) {
              parts.push(
                `Tool "${call.name}" crashed. Try "${alternative}" instead.`,
              );
            }
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.hints", { hints: parts.map((h) => `- ${h}`).join("\n") })}</system-summary>`,
            });
          }
        } else {
          this.stuckDetector.recordToolSuccess();

          // When a bash command runs code successfully, suggest marking step as done
          if (call.name === "bash" && result.success && ctx.contextManager) {
            const cmd = String(call.arguments?.command ?? "");
            if (/node|tsx|ts-node|python|npm\s+(start|test|run)/.test(cmd)) {
              ctx.contextManager.addMessage({
                role: "user",
                content: `<system-summary>The command "${cmd}" completed successfully. If this was testing your code, mark the current step as done via plan update step=N status=done.</system-summary>`,
              });
            }
          }
        }

        if (
          result.success &&
          (call.name === "write_file" || call.name === "edit_file")
        ) {
          const filePath = call.arguments?.path as string;
          if (filePath) {
            this.stuckDetector.recordFileRewrite(filePath);
            if (this.stuckDetector.hasExcessiveRewrites()) {
              const file = this.stuckDetector.getExcessiveRewriteFile();
              const count = this.stuckDetector.getFileRewriteCount(file!);
              if (ctx.onMeta) {
                ctx.onMeta(
                  t("exec.file_rewrite_warning", {
                    file: file!,
                    count: String(count),
                  }),
                );
              }
            }
          }
          this.advancePlanIfStepComplete(ctx.contextManager, ctx.sessionLog);
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

  private advancePlanIfStepComplete(
    contextManager?: any,
    sessionLog?: {
      plan(event: string, detail: string, iteration?: number): void;
    },
  ): void {
    const step = this.tracker?.getCurrentStep();
    if (!step) return;
    const stepText = step.description.toLowerCase();
    const stepPaths = step.description.match(/\b[\w./\\-]+\.[a-z]+/gi) || [];

    // Step gate: verify dependencies when mentioned — check BEFORE file paths
    const isDepsStep =
      stepText.includes("install") ||
      stepText.includes("зависим") ||
      stepText.includes("init") ||
      stepText.includes("инициализац");
    if (isDepsStep) {
      const lockFiles = [
        "package-lock.json",
        "bun.lockb",
        "yarn.lock",
        "pnpm-lock.yaml",
        "node_modules",
        "go.sum",
        "Cargo.lock",
        "Pipfile.lock",
        "poetry.lock",
        "requirements.txt",
      ];
      const hasLockFile = lockFiles.some((f) =>
        existsSync(resolve(this.baseDir, f)),
      );
      if (!hasLockFile) {
        if (contextManager) {
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>${t("exec.step_gate_deps", { step: String(step.id), description: step.description })}</system-summary>`,
          });
        }
        return;
      }
    }

    if (stepPaths.length === 0) return;

    const allExist = stepPaths.every((p) =>
      existsSync(resolve(this.baseDir, p)),
    );

    if (!allExist) return;

    // Step gate: verify files have content (not empty)
    const emptyFiles: string[] = [];
    for (const p of stepPaths) {
      try {
        const content = readFileSync(resolve(this.baseDir, p), "utf-8");
        if (content.trim().length < 10) {
          emptyFiles.push(p);
        }
      } catch {
        // If we can't read it, rely on existsSync result
      }
    }

    if (emptyFiles.length > 0 && contextManager) {
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${t("exec.step_gate_empty", { step: String(step.id), files: emptyFiles.join(", ") })}</system-summary>`,
      });
      return;
    }

    // All checks passed — advance
    this.tracker?.updateStepStatus(step.id, "done");
    const hadNext = this.tracker?.advance() ?? false;
    if (this.tracker) {
      this.persister.save(this.tracker.getPlan());
      sessionLog?.plan(
        "auto-advance",
        `Step ${step.id} auto-completed | ${this.tracker.getProgressString()} | current: step ${this.tracker.getCurrentStepIndex() + 1}`,
      );
    }

    if (contextManager) {
      const nextStep = hadNext ? this.tracker?.getCurrentStep() : null;
      const nextMsg = nextStep
        ? t("exec.step_gate_ok", {
            step: String(step.id),
            nextStep: String(nextStep.id),
            nextDesc: nextStep.description,
          })
        : t("exec.step_gate_last", { step: String(step.id) });
      contextManager.addMessage({
        role: "user",
        content: `<system-summary>${nextMsg}</system-summary>`,
      });
    }
  }

  /**
   * Extract the original task statement from the first user message in the
   * conversation history. Used to validate plan coverage against requirements.
   */
  private getTaskText(ctx: any): string {
    const manager = ctx?.contextManager;
    if (!manager) return "";
    const history = manager.getActiveHistory();
    const firstUser = history.find((m: { role: string }) => m.role === "user");
    if (!firstUser) return "";
    return getMessageText(firstUser.content).trim();
  }
}
