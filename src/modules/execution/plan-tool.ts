import type { ToolDefinition } from "../../tools/types";
import { t } from "../../i18n/index";
import { PlanCreator, type Plan, type StepKind } from "./planner";
import type { PlanTracker } from "./tracker";
import { PlanStore } from "./plan-store";
import { StepVerifier } from "./verifier";
import { checkPlanCoverage } from "./plan-coverage";
import { stepTypecheckGate } from "./execution-plugin";

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
        'Create, update, show, abort, list, switch, delete, purge, or re-plan multi-step plans.\n\nActions:\n- create: Start a new plan. Previous active plan is auto-preserved: incomplete → draft, complete → archive.\n- update: Mark step status (done/failed/skipped), or rebuild plan with new steps.\n- show: Print current plan checklist.\n- abort: Archive the current plan (or the plan given by id) and clear the active slot.\n- list: Show all plans (active, drafts, archived) with progress.\n- switch: Make a different plan active (by plan id).\n- re-plan: Iterative replanning: keep completed steps, replace remaining with new steps.\n- delete: Permanently delete a plan by id (plan delete id=plan_xxx).\n- purge: Delete ALL plans (active, drafts, archived).\n\nWrite CONCRETE steps with exact file paths and commands:\n- Specify WHICH files to create with exact paths (e.g. "create src/components/Header.tsx with navigation and logo")\n- Specify WHICH packages to install (e.g. "run npm install react react-dom")\n- Specify WHICH CLI commands to run with exact arguments\n- Each step should include at least one file extension (.ts, .tsx, .json, etc.) or a command verb (install, create, build, run, add, init)\n- Good: "Создать src/components/Header.tsx с навигацией и логотипом"\n- Bad: "Настройка проекта" (too vague — what exactly needs to be configured?)\n- For steps that REMOVE files, pass kinds: ["delete"] aligned with steps (the done-gate verifies those files are gone instead of demanding they exist).',
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
          kinds: {
            type: "array",
            items: { type: "string", enum: ["create", "delete"] },
            description:
              'Optional per-step intent, aligned 1:1 with steps. Pass "delete" for steps whose purpose is REMOVING files — the done-gate then requires those files to be GONE (not present). Defaults to "create".',
          },
          step: { type: "number" },
          status: { type: "string", enum: ["done", "failed", "skipped"] },
          note: { type: "string" },
          id: { type: "string", description: "Plan id (for switch action)" },
        },
        required: ["action"],
      },
      handler: async (_ctx, args) => {
        const action = String(args.action);

        if (action === "list") {
          const metas = deps.store.listAll();
          if (metas.length === 0) {
            return { success: true, output: t("plan.list_empty") };
          }
          const lines = metas.map((m) => {
            const icon = m.status === "active" ? "[*]" : m.status === "draft" ? "[ ]" : "[-]";
            const namePart = m.name ? ` (${m.name})` : "";
            return `${icon} ${m.id}${namePart} — ${m.title}  ${m.doneCount}/${m.stepCount}`;
          });
          lines.push("");
          lines.push(t("plan.list_legend"));
          return {
            success: true,
            output: `${t("plan.list_header")}\n${lines.join("\n")}`,
          };
        }

        if (action === "switch") {
          const planId = String(args.id || "");
          if (!planId) {
            return { success: false, output: t("plan.switch_no_id") };
          }
          const found = deps.store.find(planId);
          if (!found) {
            return {
              success: false,
              output: t("plan.not_found", { id: planId }),
            };
          }
          // Switching to the plan that is already active must be a no-op, not
          // a duplicate (observed: switch on the active plan preserved the
          // active.json and re-set the same plan, leaving two copies).
          if (found.status === "active") {
            return {
              success: true,
              output: t("plan.already_active", {
                id: found.plan.id,
                title: found.plan.title,
              }),
              display: deps.trackerRef.current?.toPromptBlock(),
            };
          }
          deps.preserveActive();
          if (found.status === "draft") {
            deps.store.removeDraft(found.plan.id);
          } else if (found.status === "archived") {
            deps.store.removeArchived(found.plan.id);
          }
          deps.setPlan(found.plan);
          // Display from the tracker (setPlan syncs the pointer past any
          // done/skipped steps) so "current: step N" points at the first
          // pending step of the switched-to plan, not always step 1.
          const display = deps.trackerRef.current?.toPromptBlock();
          return {
            success: true,
            output: t("plan.switched", {
              id: found.plan.id,
              title: found.plan.title,
            }),
            display,
          };
        }

        if (action === "re-plan") {
          if (!deps.trackerRef.current) {
            return { success: false, output: t("plan.no_active") };
          }
          const newSteps = Array.isArray(args.steps) ? args.steps.map(String) : [];
          if (newSteps.length === 0) {
            return { success: false, output: t("plan.replan_no_steps") };
          }
          const tracker = deps.trackerRef.current;
          const oldPlan = tracker.getPlan();
          const replanned = PlanCreator.replan(
            oldPlan,
            newSteps,
            args.title ? String(args.title) : undefined,
          );
          const keptCount = replanned.steps.length - newSteps.length;
          deps.setPlan(replanned);
          const display = deps.trackerRef.current?.toPromptBlock();
          return {
            success: true,
            output: t("plan.replanned", {
              kept: String(keptCount),
              steps: String(newSteps.length),
            }),
            display,
          };
        }

        if (action === "create") {
          const title = String(args.title || "Task Plan");
          const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
          if (steps.length === 0) {
            return { success: false, output: t("plan.no_steps") };
          }
          const parsed = deps.parseKinds(args, steps);
          if (parsed.error) {
            return { success: false, output: parsed.error };
          }

          // Never silently discard an in-progress plan (observed:
          // ses_msvuao0h — right after compaction the model called
          // `plan create` again, dumping the 1/6 plan into drafts and
          // starting from scratch). An active plan WITH progress blocks
          // creation until the model consciously aborts it. A fresh plan
          // (all steps pending) is safe to replace — the model may have
          // just changed its mind about the approach.
          const existing = deps.trackerRef.current;
          if (existing) {
            const activePlan = existing.getPlan();
            const progressed = activePlan.steps.some(
              (s) => s.status === "done" || s.status === "failed" || s.status === "skipped",
            );
            if (progressed) {
              const done = activePlan.steps.filter((s) => s.status === "done").length;
              return {
                success: false,
                output: t("plan.active_in_progress", {
                  id: activePlan.id,
                  done: String(done),
                  total: String(activePlan.steps.length),
                  current: String(existing.getCurrentStepIndex() + 1),
                }),
              };
            }
          }

          deps.preserveActive();
          const plan = PlanCreator.createPlan(title, steps, deps.baseDir, parsed.kinds ?? []);
          deps.setPlan(plan);
          const display = PlanCreator.toPromptBlock(plan, 0);
          let output = t("plan.created", {
            title,
            steps: String(steps.length),
          });
          // The model sometimes passes an id expecting the plan to be
          // created under it (observed: id "plan_error_check_e07pb2" was
          // ignored, a new id appeared). Be explicit so it doesn't look
          // for a plan by the wrong id afterwards.
          if (args.id) {
            output += `\n${t("plan.id_ignored")}`;
          }
          if (existing) {
            output += `\n${t("plan.existing_fresh")}`;
          }
          let displayOut = display;
          const taskText = deps.getTaskText(_ctx);
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
          const planId = args.id ? String(args.id) : "";
          if (planId && planId !== deps.trackerRef.current?.getPlan()?.id) {
            // Show a specific plan (active, draft, or archived) instead
            // of ignoring the id and always printing the active one
            // (observed: the model asked for an archived plan three
            // times and got the active plan back every time).
            const found = deps.store.find(planId);
            if (!found) {
              return {
                success: false,
                output: t("plan.not_found", { id: planId }),
              };
            }
            const display = PlanCreator.toPromptBlock(found.plan, 0);
            return {
              success: true,
              output: `${t("plan.show_header")}\n${display}`,
              display,
            };
          }
          if (!deps.trackerRef.current) {
            return { success: false, output: t("plan.no_active") };
          }
          const display = deps.trackerRef.current.toPromptBlock();
          return {
            success: true,
            output: `${t("plan.show_header")}\n${display}`,
            display,
          };
        }
        if (action === "update" && args.step && deps.trackerRef.current) {
          const tracker = deps.trackerRef.current;
          const stepId = Number(args.step);
          const target = tracker.getStep(stepId);
          if (!target) {
            return { success: false, output: t("plan.step_not_found") };
          }
          const status = String(args.status || "done");

          // Completed plan: re-marking a done step of a finished plan is the
          // loop anchor (observed: 3× "plan update step=4 done" on a 4/4 plan
          // while a NEW task waited). Archive + clear so the model can create a
          // fresh plan for the new task instead of spinning.
          if (tracker.isComplete()) {
            const plan = tracker.getPlan();
            deps.store.archivePlan(plan);
            deps.recordCompleted(plan); // final audit still verifies it
            deps.trackerRef.current = null;
            const done = plan.steps.filter((s) => s.status === "done").length;
            return {
              success: true,
              output: t("plan.completed_archived", {
                id: plan.id,
                done: String(done),
                total: String(plan.steps.length),
              }),
            };
          }

          // Idempotency: re-marking a done step as done usually means the
          // plan was already auto-advanced (all step files exist) and the
          // model is confirming its own work. Return SUCCESS so the loop
          // isn't confused — a small model misreads success:false as a
          // failed action and retries/spins. Genuine spinning (repeated
          // identical calls without new work) is still caught by the
          // stuck-detector's consecutive-identical-call check.
          if (status === "done" && target.status === "done") {
            const progress = tracker.getProgressString();
            const display = tracker.toPromptBlock();
            return {
              success: true,
              output: `${t("plan.step_already_done", {
                step: String(stepId),
              })}\n${progress}`,
              display,
            };
          }

          // Order enforcement: only the CURRENT step may be marked done.
          // Prevents jumping ahead (step 5 marked done before steps 1-4,
          // observed in the post-mortem session) and the follow-on audit
          // failures ("5/5 steps done, 5 files missing").
          if (status === "done") {
            const blockers = tracker
              .getPlan()
              .steps.filter((s) => s.id < stepId && s.status !== "done" && s.status !== "skipped");
            if (blockers.length > 0) {
              return {
                success: false,
                output: t("plan.order_blocked", {
                  step: String(stepId),
                  first: String(blockers[0].id),
                  desc: blockers[0].description,
                }),
              };
            }
          }

          // Deliverable gate: marking a step done must match its declared
          // intent. "create" (default) → named files must exist; "delete"
          // → named files must be GONE. Intent is model-declared (kind),
          // never keyword-inferred (rule #10).
          //
          // Auto-switch: when kind is "create" but ALL named files are gone,
          // check if the agent actually deleted them (via delete_file/bash rm).
          // Only then switch to "delete" — files that were never created
          // (create-kind steps) remain blocked so the agent must create them.
          if (status === "done" && target.kind !== "delete") {
            const missing = deps.missingStepDeliverables(target);
            if (missing.length > 0) {
              const existing = deps.stillExistingDeliverables(target);
              const allGone = deps.hasStepDeliverables(target) && existing.length === 0;
              if (allGone) {
                // Confirm the agent actually deleted these files (not just
                // never created them) before auto-switching.
                const wasDeleted = deps.wasFileDeleted
                  ? missing.every((f) => deps.wasFileDeleted!(f))
                  : false;
                if (wasDeleted) {
                  target.kind = "delete";
                  deps.store.saveActive(tracker.getPlan());
                }
              }
            }
          }

          if (status === "done") {
            if (target.kind === "delete") {
              const leftovers = deps.stillExistingDeliverables(target);
              if (leftovers.length > 0) {
                return {
                  success: false,
                  output: t("plan.deliverables_remain", {
                    step: String(stepId),
                    files: leftovers.join(", "),
                  }),
                };
              }
            } else {
              const missing = deps.missingStepDeliverables(target);
              if (missing.length > 0) {
                return {
                  success: false,
                  output: t("plan.deliverables_missing", {
                    step: String(stepId),
                    files: missing.join(", "),
                  }),
                };
              }
            }
          }

          // Typecheck gate: "done" while the last edit still fails to compile
          // is a self-certification the harness must refuse (observed: steps
          // marked done with the project typecheck failing on every write —
          // a "fix it later" cascade that never got fixed). The model must
          // either fix the errors (a clean re-edit clears the map) or mark
          // the step skipped.
          if (status === "done") {
            const blocked = stepTypecheckGate(deps.typecheckFailures, target.description);
            if (blocked) {
              return {
                success: false,
                output: t("plan.typecheck_failed", {
                  step: String(stepId),
                  error: blocked,
                }),
              };
            }
          }

          tracker.updateStepStatus(stepId, status as any);
          if (args.note) tracker.addNote(Number(args.step), String(args.note));
          tracker.syncCurrentStep();
          deps.store.saveActive(tracker.getPlan());
          // A "done" step that names no file tokens has a vacuous gate — its
          // completion cannot be auto-verified. Inform the model so it can
          // run an explicit check or add file paths to the step description.
          const vacuousGate = status === "done" && !deps.hasStepDeliverables(target);
          const vacuousNote = vacuousGate
            ? `\n${t("plan.no_deliverables", { step: String(stepId) })}`
            : "";

          // If this update completed the last step → auto-archive. This breaks
          // the loop where a finished plan stays active and anchors the model
          // to "continue step N, do NOT create a new plan".
          if (tracker.isComplete()) {
            const plan = tracker.getPlan();
            deps.store.archivePlan(plan);
            deps.recordCompleted(plan); // final audit still verifies it
            deps.trackerRef.current = null;
            const done = plan.steps.filter((s) => s.status === "done").length;
            return {
              success: true,
              output: `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })}\n${t(
                "plan.completed_archived",
                {
                  id: plan.id,
                  done: String(done),
                  total: String(plan.steps.length),
                },
              )}${vacuousNote}`,
            };
          }

          const progress = tracker.getProgressString();
          const display = tracker.toPromptBlock();
          _ctx.sessionLog?.plan(
            "step-update",
            `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })} | ${progress} | current: step ${tracker.getCurrentStepIndex() + 1}`,
          );
          return {
            success: true,
            output: `${t("plan.step_status", { step: String(args.step), status: String(args.status || "done") })}\n${progress}${vacuousNote}`,
            display,
          };
        }
        if (
          action === "update" &&
          Array.isArray(args.steps) &&
          args.steps.length > 0 &&
          deps.trackerRef.current
        ) {
          const tracker = deps.trackerRef.current;
          const title = String(args.title || tracker.getPlan().title);
          const steps = args.steps.map(String);
          const parsed = deps.parseKinds(args, steps);
          if (parsed.error) {
            return { success: false, output: parsed.error };
          }
          const plan = PlanCreator.createPlan(title, steps, deps.baseDir, parsed.kinds ?? []);
          deps.setPlan(plan);
          const display = deps.trackerRef.current?.toPromptBlock();
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
          const planId = args.id ? String(args.id) : "";
          if (planId) {
            // Abort a SPECIFIC plan (not the active one). Draft → archive,
            // active → archive + clear tracker. Archived plans are already
            // terminal — there is nothing to abort.
            const found = deps.store.find(planId);
            if (!found) {
              return {
                success: false,
                output: t("plan.not_found", { id: planId }),
              };
            }
            if (found.status === "archived") {
              return {
                success: false,
                output: t("plan.already_archived", { id: planId }),
              };
            }
            deps.store.archivePlan(found.plan); // clears active if it was active
            if (found.status === "active") {
              deps.trackerRef.current = null;
              deps.clearCompleted();
            }
            return {
              success: true,
              output: t("plan.aborted_id", { id: found.plan.id }),
            };
          }
          const tracker = deps.trackerRef.current;
          if (!tracker) {
            // Abort with no active plan and no id — previously returned
            // success:true, which made the model believe it aborted a plan
            // that did not exist (observed: 3× abort on an empty list).
            return { success: false, output: t("plan.no_active") };
          }
          deps.store.archivePlan(tracker.getPlan());
          deps.trackerRef.current = null;
          deps.store.clearActive();
          deps.clearCompleted();
          return { success: true, output: t("plan.aborted") };
        }
        if (action === "delete") {
          const planId = String(args.id || "");
          if (!planId) {
            return { success: false, output: t("plan.delete_no_id") };
          }
          const deleted = deps.store.deletePlan(planId);
          if (!deleted) {
            return {
              success: false,
              output: t("plan.not_found", { id: planId }),
            };
          }
          if (deleted === "active") {
            deps.trackerRef.current = null;
            deps.clearCompleted();
          }
          return {
            success: true,
            output: t("plan.deleted", { id: planId }),
          };
        }
        if (action === "purge") {
          const count = deps.store.purgeAll();
          deps.trackerRef.current = null;
          deps.clearCompleted();
          return {
            success: true,
            output: t("plan.purged", { count: String(count) }),
          };
        }
        if (!deps.trackerRef.current) {
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
      icon: "☑️",
      alwaysOn: true,
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
          return {
            success: true,
            output: t("todo.added", {
              count: String(items.length),
              items: items.join(", "),
            }),
            display,
          };
        }
        if (action === "done") {
          const items = Array.isArray(args.items) ? args.items.map(String) : [];
          if (items.length === 0) {
            return {
              success: false,
              output: t("todo.no_items"),
            };
          }
          const subs = currentStep.subtasks ?? [];
          let marked = 0;
          for (const item of items) {
            const sub = subs.find((s) => !s.done && s.text.toLowerCase() === item.toLowerCase());
            if (sub) {
              sub.done = true;
              marked++;
            }
          }
          if (marked === 0) {
            return {
              success: false,
              output: t("todo.subtask_not_found", {
                items: items.join(", "),
              }),
            };
          }
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
            output += `\nAll sub-tasks done — call plan update step=${currentStep.id} status=done to complete this step.`;
          }
          return { success: true, output, display };
        }
        if (action === "list") {
          const subs = currentStep.subtasks ?? [];
          const lines = subs.length
            ? subs.map((s) => `${s.done ? "[x]" : "[ ]"} ${s.text}`)
            : ["(no sub-tasks)"];
          return {
            success: true,
            output: `Step ${currentStep.id}: ${currentStep.description}\n${lines.join("\n")}`,
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
