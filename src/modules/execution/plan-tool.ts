import type { ToolDefinition } from "../../tools/types";
import { t } from "../../i18n/index";
import type { Plan, StepKind, Subtask } from "./planner";
import type { PlanTracker } from "./tracker";
import type { PlanStore } from "./plan-store";
import type { StepVerifier } from "./verifier";
import { dispatchPlanAction, updatePlanStep } from "./plan-actions";

export interface PlanToolDeps {
  store: PlanStore;
  verifier: StepVerifier;
  trackerRef: { current: PlanTracker | null };
  preserveActive(): void;
  setPlan(plan: Plan): void;
  /** Remember a completed plan so the final audit can still verify it after
   *  the tracker is cleared by the auto-archive. */
  recordCompleted(plan: Plan): void;
  /** Forget the completed plan (abort/delete/purge). */
  clearCompleted(): void;
  hasStepDeliverables(step: { description: string }): boolean;
  missingStepDeliverables(step: { description: string }): string[];
  stillExistingDeliverables(step: { description: string }): string[];
  parseKinds(
    args: Record<string, unknown>,
    steps: string[],
  ): { kinds: StepKind[] | null; error: string | null };
  /** Validate the per-step verification contracts (REQUIRED on create and
   *  re-plan, aligned 1:1 with steps). See plan-checks.ts for prefixes. */
  parseChecks(
    args: Record<string, unknown>,
    steps: string[],
  ): { checks: string[] | null; error: string | null };
  getTaskText(ctx: any): string;
  /** Files the last write/edit reported as compile-broken (from the execution
   *  plugin state). The done-gate refuses while a step's files are in here. */
  typecheckFailures: ReadonlyMap<string, string>;
  baseDir: string;
  /** Check if a file was tracked as deleted by the agent (ConsistencyCheck).
   *  Used by the auto-switch logic to confirm the model actually deleted the
   *  file (via delete_file or bash rm) before switching kind to delete. */
  wasFileDeleted?(path: string): boolean;
}

/**
 * Mark subtasks done by numeric ids (preferred) or by exact text (fallback).
 * Returns the number marked, or an error string when nothing matched.
 */
function markTodoDone(
  subs: Subtask[],
  ids: number[],
  items: string[],
): { marked: number } | { error: string } {
  let marked = 0;
  if (ids.length > 0) {
    for (const id of ids) {
      const sub = subs.find((s) => !s.done && s.id === id);
      if (sub) {
        sub.done = true;
        marked++;
      }
    }
    if (marked === 0) {
      return {
        error: t("todo.subtask_id_not_found", { ids: ids.join(", ") }),
      };
    }
    return { marked };
  }
  for (const item of items) {
    const sub = subs.find((s) => !s.done && s.text.toLowerCase() === item.toLowerCase());
    if (sub) {
      sub.done = true;
      marked++;
    }
  }
  if (marked === 0) {
    return {
      error: t("todo.subtask_not_found", { items: items.join(", ") }),
    };
  }
  return { marked };
}

/**
 * The plan / todo / verify tool definitions for the execution module. The
 * handlers were extracted verbatim from ExecutionModule.getToolDefinitions() —
 * all state access goes through the `deps` closures (the module owns the
 * tracker and the plan store).
 */
export function createPlanToolDefinitions(deps: PlanToolDeps): ToolDefinition[] {
  return [
    {
      name: "plan",
      icon: "📋",
      alwaysOn: true,
      description:
        'Create, update, show, abort, list, switch, delete, purge, or re-plan multi-step plans.\n\nActions:\n- create: Start a new plan. Previous active plan is auto-preserved: incomplete → draft, complete → archive.\n- update: Mark step status (done/failed/skipped). To change the plan\'s steps use "re-plan" (keeps completed steps) or "create".\n- show: Print current plan checklist.\n- abort: Archive the current plan (or the plan given by id) and clear the active slot.\n- list: Show all plans (active, drafts, archived) with progress.\n- switch: Make a different plan active (by plan id).\n- re-plan: Iterative replanning: keep completed steps, replace remaining with new steps.\n- delete: Permanently delete a plan by id (plan delete id=plan_xxx).\n- purge: Delete ALL plans (active, drafts, archived).\n\nWrite CONCRETE steps with exact file paths and commands:\n- Specify WHICH files to create with exact paths (e.g. "create src/components/Header.tsx with navigation and logo")\n- Specify WHICH packages to install (e.g. "run npm install react react-dom")\n- Specify WHICH CLI commands to run with exact arguments\n- Each step should include at least one file extension (.ts, .tsx, .json, etc.) or a command verb (install, create, build, run, add, init)\n- Good: "Создать src/components/Header.tsx с навигацией и логотипом"\n- Bad: "Настройка проекта" (too vague — what exactly needs to be configured?)\n- Steps that REMOVE files need no extra flag: create/delete intent is detected automatically from what the agent actually does.\n- Every step needs a verification contract: pass "checks" aligned 1:1 with "steps". Each check is "file-exists:<path>" (verified automatically on done), "command:<exact command>" (run it before done), or "manual:<what to check by eye>" (UI/visual work only). Example: steps ["Create src/a.ts with X"] + checks ["file-exists:src/a.ts"].',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "create",
              "update",
              "show",
              "abort",
              "list",
              "switch",
              "re-plan",
              "delete",
              "purge",
            ],
          },
          title: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          checks: {
            type: "array",
            items: { type: "string" },
            description:
              'REQUIRED on create/re-plan, aligned 1:1 with steps. One contract per step: "file-exists:<path>", "command:<cmd>", or "manual:<text>".',
          },
          step: { type: "number" },
          status: { type: "string", enum: ["done", "failed", "skipped"] },
          note: { type: "string" },
          id: { type: "string", description: "Plan id (for switch action)" },
        },
        required: ["action"],
      },
      handler: async (ctx, args) => {
        const action = String(args.action);
        // Диспетчер по действию: по одной функции на action (plan-actions.ts).
        const result = dispatchPlanAction(action, deps, ctx, args);
        if (result !== null) return result;
        return {
          success: false,
          output: t("plan.unknown_action", { action }),
        };
      },
    },
    {
      name: "plan_step",
      icon: "📋",
      alwaysOn: true,
      description:
        'Mark ONE plan step done/failed/skipped: plan_step step=N status=done|failed|skipped (note="..." optional). Prefer this over "plan update" — no action parameter to confuse. The step\'s check contract is verified automatically on done ("file-exists:" hard-verified, "command:"/"manual:" self-certified).',
      parameters: {
        type: "object",
        properties: {
          step: { type: "number", description: "Step number to update" },
          status: { type: "string", enum: ["done", "failed", "skipped"] },
          note: { type: "string" },
        },
        required: ["step"],
      },
      handler: async (ctx, args) => {
        if (!deps.trackerRef.current) {
          return { success: false, output: t("plan.no_active") };
        }
        if (args.step === undefined || args.step === null || Number.isNaN(Number(args.step))) {
          return { success: false, output: t("plan.step_required") };
        }
        return updatePlanStep(deps, ctx, args);
      },
    },
    {
      name: "todo",
      icon: "☑️",
      alwaysOn: true,
      description:
        "Manage sub-tasks within current plan step. Use to break down complex steps into smaller tasks. Mark done by subtask ids from todo list (ids=[...]) — reliable; matching by text is a fallback.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "done", "list"] },
          items: { type: "array", items: { type: "string" } },
          ids: {
            type: "array",
            items: { type: "number" },
            description: "Subtask ids to mark done (see todo list output). Preferred over items.",
          },
        },
        required: ["action"],
      },
      handler: async (_ctx, args) => {
        if (!deps.trackerRef.current) {
          return { success: false, output: t("plan.no_active") };
        }
        const tracker = deps.trackerRef.current;
        const action = String(args.action);
        const currentStep = tracker.getCurrentStep();
        if (!currentStep) {
          return { success: false, output: t("plan.step_not_found") };
        }
        if (action === "add" && Array.isArray(args.items)) {
          const items = args.items.map(String);
          const existing = currentStep.subtasks ?? [];
          let nextId = existing.reduce((m, s) => Math.max(m, s.id), 0) + 1;
          for (const item of items) {
            existing.push({ id: nextId++, text: item, done: false });
          }
          currentStep.subtasks = existing;
          deps.store.saveActive(tracker.getPlan());
          const display = tracker.toPromptBlock();
          const addedIds = existing.slice(-items.length).map((s) => s.id);
          const addedOutput =
            t("todo.added", {
              count: String(items.length),
              items: items.join(", "),
            }) + ` (ids: ${addedIds.join(", ")})`;
          return {
            success: true,
            output: addedOutput,
            display,
          };
        }
        if (action === "done") {
          const ids = Array.isArray(args.ids) ? args.ids.map(Number).filter((n) => !Number.isNaN(n)) : [];
          const items = Array.isArray(args.items) ? args.items.map(String) : [];
          if (ids.length === 0 && items.length === 0) {
            return {
              success: false,
              output: t("todo.no_items"),
            };
          }
          const subs = currentStep.subtasks ?? [];
          const done = markTodoDone(subs, ids, items);
          if ("error" in done) {
            return { success: false, output: done.error };
          }
          const marked = done.marked;
          currentStep.subtasks = subs;
          deps.store.saveActive(tracker.getPlan());
          const doneCount = subs.filter((s) => s.done).length;
          const display = tracker.toPromptBlock();
          // Marking a sub-task done must NOT auto-complete the plan
          // step — the step is only done when the model confirms the
          // whole step via plan update (observed: 3 × "todo done"
          // returned "Step 3: done" and marked the step done early).
          let output = t("todo.marked_done", {
            count: String(marked),
          });
          output += ` (${doneCount}/${subs.length})`;
          if (doneCount === subs.length) {
            output += `\n${t("plan.subtasks_done", { stepId: String(currentStep.id) })}`;
          }
          return { success: true, output, display };
        }
        if (action === "list") {
          const subs = currentStep.subtasks ?? [];
          const lines = subs.length
            ? subs.map((s) => `[${s.id}] ${s.done ? "[x]" : "[ ]"} ${s.text}`)
            : [t("plan.no_subtasks")];
          return {
            success: true,
            output: `${t("plan.step_label", { stepId: String(currentStep.id), description: currentStep.description })}\n${lines.join("\n")}`,
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
      icon: "✅",
      alwaysOn: true,
      description:
        "Run verification for the current step. Checks files mentioned in the step description.",
      parameters: {
        type: "object",
        properties: {
          step: { type: "number", description: "Step number to verify" },
        },
      },
      handler: async (_ctx, args) => {
        if (!deps.trackerRef.current) return { success: false, output: t("plan.no_active") };
        const tracker = deps.trackerRef.current;
        const step = args.step ? tracker.getStep(Number(args.step)) : tracker.getCurrentStep();
        if (!step) return { success: false, output: t("plan.step_not_found") };
        const result = await deps.verifier.verifyStep(step.description, step.kind);
        if (result.noFiles) {
          return {
            success: true,
            output: t("verify.no_files", { step: String(step.id) }),
          };
        }
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
