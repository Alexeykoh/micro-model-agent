import type { AgentModule } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition } from "../../tools/types";
import type { AgentPlugin } from "../types";
import { t } from "../../i18n/index";
import { PlanTracker } from "./tracker";
import { StepVerifier } from "./verifier";
import { StuckDetector } from "./stuck-detector";
import { Auditor, findExistingFile } from "./auditor";
import { PlanStore } from "./plan-store";
import { getMessageText } from "../../llm/provider";
import type { ContentPart } from "../../llm/provider";
import type { Plan, StepKind } from "./planner";
import { extractFileLikeTokens, stripUrls } from "../hallucination/js-identifiers";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createPlanToolDefinitions } from "./plan-tool";
import {
  createExecutionPlugin,
  STUCK_RECOVERY_COOLDOWN,
  type ExecutionPluginState,
} from "./execution-plugin";

export class ExecutionModule implements AgentModule {
  name = "execution";
  private tracker: PlanTracker | null = null;
  private verifier: StepVerifier;
  private stuckDetector: StuckDetector;
  private auditor: Auditor;
  private store: PlanStore;
  private baseDir: string;
  // Skip the first audit after restoring a plan from disk — gives the user
  // one chance to change the subject before the audit gate locks in.
  private _auditSkipsRemaining = 0;
  /**
   * Deferred <system-summary> messages. Injected by onBeforeTool/onAfterTool
   * but flushed in onBeforeThink, so they never land between an assistant
   * tool_call message and its tool results (which breaks message pairing and
   * buries the warnings the model should react to).
   */
  private pendingMessages: Array<{ role: "user"; content: string }> = [];
  // Per-command failure counters for forbidden Windows commands (grep/sed/ls/
  // find/… invoked through the bash tool). A hard stop after the second
  // failure is evidence-based (actual command failures), not task
  // classification (rule #10).
  private forbiddenBashFailures = new Map<string, number>();

  /**
   * The execution-plugin's mutable state. Owned HERE and passed BY REFERENCE
   * to the plugin factory — the plugin writes deps.state.* directly, so the
   * assignments are visible on the module without any write-back.
   */
  private state: ExecutionPluginState = {
    lastRecoveryIteration: -STUCK_RECOVERY_COOLDOWN,
    consecutivePlanWarnings: 0,
    lastStepId: -1,
    stuckNotified: false,
    depsGateHints: new Map<number, number>(),
  };

  /**
   * Read/write accessor for the tracker, shared with the plan-tool and
   * execution-plugin factories. The `plan` tool's abort action clears it
   * (current = null) — the setter keeps this.tracker in sync. Object-literal
   * getters bind `this` to the literal, so the instance is captured in a
   * closure instead.
   */
  private trackerRef: {
    get current(): PlanTracker | null;
    set current(v: PlanTracker | null);
  } = (() => {
    const self = this;
    return {
      get current(): PlanTracker | null {
        return self.tracker;
      },
      set current(v: PlanTracker | null) {
        self.tracker = v;
      },
    };
  })();

  constructor(baseDir: string, stuckThreshold = 6) {
    this.baseDir = baseDir;
    this.verifier = new StepVerifier(baseDir);
    this.stuckDetector = new StuckDetector(stuckThreshold);
    this.auditor = new Auditor(baseDir);
    this.store = new PlanStore(baseDir);
  }

  setPlan(plan: Plan): void {
    this.tracker = new PlanTracker(plan);
    this.store.saveActive(plan);
    this._auditSkipsRemaining = 0; // plan explicitly created — arm the audit gate
  }

  restorePlan(): boolean {
    const plan = this.store.loadActive();
    if (!plan) return false;
    const restored = new PlanTracker(plan);
    // A plan that was already complete when saved must not come back as the
    // active plan — archive it so it cannot re-anchor the agent (restored
    // completed plans caused the "continue step 4" loop on restart).
    if (restored.isComplete()) {
      this.store.archivePlan(plan);
      this.tracker = null;
      return false;
    }
    this.tracker = restored;
    // Advance to the first non-done step
    this.tracker.syncCurrentStep();
    this._auditSkipsRemaining = 1; // restored plan — one free pass
    return true;
  }

  getTracker(): PlanTracker | null {
    return this.tracker;
  }

  getStore(): PlanStore {
    return this.store;
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
    const pendingSteps = plan.steps.flatMap((s) =>
      s.status !== "done" && s.status !== "skipped" ? [`${s.id}. ${s.description}`] : [],
    );
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
    if (!this.tracker || this.tracker.isComplete()) return null;
    return {
      content: this.tracker.toPromptBlock(),
      priority: "critical",
      essential: true,
      estimatedTokens: 200,
    };
  }

  /**
   * Short "current plan" line for the compaction summary. Null when no plan
   * is active. For 9B models the explicit instruction "continue it, do NOT
   * create a new plan" matters — after compaction the plan block is visible
   * but the model re-creates the plan anyway (observed: ses_msvuao0h).
   *
   * When the plan is complete, the summary says the plan is done and the
   * model may create a new plan — NOT "continue step 4, do NOT create a
   * new plan" which anchored the ses_msxjbnm4 loop.
   */
  getPlanSummary(): string | null {
    if (!this.tracker) return null;
    const plan = this.tracker.getPlan();
    const done = plan.steps.filter((s) => s.status === "done").length;
    const total = plan.steps.length;
    if (this.tracker.isComplete()) {
      return `[${plan.id}] "${plan.title}" ${done}/${total} done — plan complete. You may create a new plan for new work (plan create), or reply with your final answer.`;
    }
    const current = this.tracker.getCurrentStepIndex() + 1;
    return `[${plan.id}] "${plan.title}" ${done}/${total} done, current: step ${current} — continue it (plan show / re-plan), do NOT create a new plan`;
  }

  getToolDefinitions(): ToolDefinition[] {
    return createPlanToolDefinitions({
      store: this.store,
      verifier: this.verifier,
      trackerRef: this.trackerRef,
      preserveActive: () => this.preserveActive(),
      setPlan: (p) => this.setPlan(p),
      missingStepDeliverables: (s) => this.missingStepDeliverables(s),
      stillExistingDeliverables: (s) => this.stillExistingDeliverables(s),
      parseKinds: (a, st) => this.parseKinds(a, st),
      getTaskText: (c) => this.getTaskText(c),
      baseDir: this.baseDir,
    });
  }

  getPlugin(): AgentPlugin {
    return createExecutionPlugin({
      stuckDetector: this.stuckDetector,
      trackerRef: this.trackerRef,
      pendingMessages: this.pendingMessages,
      forbiddenBashFailures: this.forbiddenBashFailures,
      state: this.state,
      checkPlanAlignment: (call) => this.checkPlanAlignment(call),
      advancePlanIfStepComplete: (cm, sl) => this.advancePlanIfStepComplete(cm, sl),
    });
  }

  private preserveActive(): void {
    if (!this.tracker) return;
    const plan = this.tracker.getPlan();
    if (plan.steps.every((s) => s.status === "done" || s.status === "skipped")) {
      this.store.archivePlan(plan);
    } else {
      this.store.saveDraft(plan);
    }
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

    const stepPaths = extractFileLikeTokens(stripUrls(step.description)).map((p) =>
      p.toLowerCase(),
    );
    if (stepPaths.length === 0) return null;

    const argStr = JSON.stringify(call.arguments);
    const callPaths = extractFileLikeTokens(stripUrls(argStr)).map((p) => p.toLowerCase());

    if (callPaths.length === 0) return null;

    // Files that already belong to COMPLETED (done/skipped) steps are
    // legitimate rewrite targets — the agent iterates on them while fixing
    // LSP/type errors. Blocking those would stop normal bug-fixing.
    const plan = this.tracker.getPlan();
    const finishedPaths = new Set<string>();
    for (const s of plan.steps) {
      if (s.status === "done" || s.status === "skipped") {
        extractFileLikeTokens(stripUrls(s.description))
          .map((p) => p.toLowerCase())
          .forEach((p) => finishedPaths.add(p));
      }
    }

    const offPath = callPaths.some((p) => {
      if (finishedPaths.has(p) || [...finishedPaths].some((s) => s.includes(p))) {
        return false;
      }
      return !stepPaths.some((s) => p.includes(s) || s.includes(p));
    });
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
    // Shared file-token filter (allow-list of real extensions, extension-only
    // segments rejected). A step like "Удалить .js, оставить .tsx/.ts" must
    // NOT produce the phantom token "tsx/.ts" — that never exists, making
    // allGone trivially true and auto-advancing a delete step while the real
    // files to delete still exist (the raw regex path did exactly that).
    const stepPaths = extractFileLikeTokens(stripUrls(step.description)) || [];

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
      const hasLockFile = lockFiles.some((f) => existsSync(resolve(this.baseDir, f)));
      if (!hasLockFile) {
        if (contextManager) {
          const hints = this.state.depsGateHints.get(step.id) || 0;
          this.state.depsGateHints.set(step.id, hints + 1);
          const force = hints >= 1;
          const content = force
            ? t("exec.step_gate_deps_force", { step: String(step.id) })
            : t("exec.step_gate_deps", {
                step: String(step.id),
                description: step.description,
              });
          contextManager.addMessage({
            role: "user",
            content: `<system-summary>${content}</system-summary>`,
          });
        }
        return;
      }
    }

    if (stepPaths.length === 0) return;

    const allExist = stepPaths.every((p) => existsSync(resolve(this.baseDir, p)));
    const allGone = stepPaths.every((p) => !existsSync(resolve(this.baseDir, p)));
    const satisfied = step.kind === "delete" ? allGone && !allExist : allExist;
    if (!satisfied) return;

    // Step gate: verify files have content (not empty)
    if (step.kind !== "delete") {
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
    }

    // All checks passed — advance
    this.tracker?.updateStepStatus(step.id, "done");
    const hadNext = this.tracker?.advance() ?? false;
    if (this.tracker) {
      this.store.saveActive(this.tracker.getPlan());
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

    // Auto-archive a plan that just became complete (all steps done/skipped).
    // Keeps a finished plan from staying active forever and anchoring the agent
    // to a completed task ("continue step 4, do NOT create a new plan" — the
    // ses_msxjbnm4 loop). The per-step deliverable gate already verified files.
    if (this.tracker?.isComplete()) {
      const completed = this.tracker.getPlan();
      this.store.archivePlan(completed);
      this.tracker = null;
      sessionLog?.plan("auto-archive", `Plan ${completed.id} complete — archived`);
    }
  }

  /**
   * File tokens named in a step description that do not resolve to a real
   * file. Uses the same shared token extractor (allow-list of real file
   * extensions, URLs stripped) and the auditor's subtree resolver, so
   * "bicycles.ts" finds "bicycle-shop/src/data/bicycles.ts" and a hostname in
   * the description is never reported as a missing deliverable. Steps with no
   * file tokens (pure commands, verification runs) cannot be verified.
   */
  private missingStepDeliverables(step: { description: string }): string[] {
    const tokens = extractFileLikeTokens(stripUrls(step.description));
    if (tokens.length === 0) return [];
    return tokens.filter((p) => !findExistingFile(this.baseDir, p));
  }

  /**
   * File tokens named in a step description that still resolve to a real
   * file. The inverse of missingStepDeliverables — used by the gate for
   * delete-kind steps ("done" means the files are gone).
   */
  private stillExistingDeliverables(step: { description: string }): string[] {
    const tokens = extractFileLikeTokens(stripUrls(step.description));
    if (tokens.length === 0) return [];
    return tokens.filter((p) => findExistingFile(this.baseDir, p));
  }

  /**
   * Validate the optional per-step `kinds` argument for plan create and
   * update-with-steps. Returns length-aligned kinds or an i18n error string.
   * Absent kinds → null (caller falls back to all-create semantics). Used by
   * BOTH branches so a rebuild via update can never silently drop kinds.
   */
  private parseKinds(
    args: Record<string, unknown>,
    steps: string[],
  ): { kinds: StepKind[] | null; error: string | null } {
    if (args.kinds === undefined) return { kinds: null, error: null };
    if (!Array.isArray(args.kinds)) {
      return { kinds: null, error: t("plan.kinds_not_array") };
    }
    const kindsRaw = args.kinds.map(String);
    if (kindsRaw.length !== steps.length) {
      return { kinds: null, error: t("plan.kinds_mismatch") };
    }
    const invalid = kindsRaw.filter((k) => k !== "create" && k !== "delete");
    if (invalid.length > 0) {
      return {
        kinds: null,
        error: t("plan.kinds_invalid", {
          kinds: invalid.join(", "),
        }),
      };
    }
    return { kinds: kindsRaw as StepKind[], error: null };
  }

  /**
   * Extract the original task statement from the first user message in the
   * conversation history. Used to validate plan coverage against requirements.
   */
  private getTaskText(ctx: any): string {
    const manager = ctx?.contextManager;
    if (!manager) return "";
    const history = manager.getActiveHistory();
    // The first user message may be an injected <system-summary> (compaction
    // block) — it is NOT the task. Coverage must compare the plan against the
    // model's real instruction (observed: a compaction summary's stale file
    // list produced a bogus "plan is missing files" warning).
    const firstUser = history.find((m: { role: string; content: string | ContentPart[] }) => {
      if (m.role !== "user") return false;
      const text = getMessageText(m.content);
      return !text.startsWith("<system-summary>") && !text.includes("[Compressed:");
    });
    if (!firstUser) return "";
    return getMessageText(firstUser.content).trim();
  }
}
