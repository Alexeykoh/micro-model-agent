import type { AgentModule } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition, ToolCall } from "../../tools/types";
import type { AgentPlugin } from "../types";
import { t } from "../../i18n/index";
import { PlanCreator } from "./planner";
import { PlanTracker } from "./tracker";
import { StepVerifier } from "./verifier";
import { StuckDetector } from "./stuck-detector";
import { Auditor, findExistingFile } from "./auditor";
import { PlanStore } from "./plan-store";
import { checkPlanCoverage } from "./plan-coverage";
import { getMessageText } from "../../llm/provider";
import type { ContentPart } from "../../llm/provider";
import { detectTestResults } from "../../tools/bash";
import type { Plan } from "./planner";
import {
	extractFileLikeTokens,
	stripUrls,
} from "../hallucination/js-identifiers";
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
	private store: PlanStore;
	private baseDir: string;
	private lastRecoveryIteration = -STUCK_RECOVERY_COOLDOWN;
	private consecutivePlanWarnings = 0;
	private lastStepId = -1;
	// How many times the deps-step gate has warned for each step id — used to
	// escalate from a soft hint to a MUST-update instruction (models otherwise
	// spin on "install dependencies" steps they invented themselves).
	private depsGateHints = new Map<number, number>();
	// Skip the first audit after restoring a plan from disk — gives the user
	// one chance to change the subject before the audit gate locks in.
	private _auditSkipsRemaining = 0;
	private stuckNotified = false;
	/**
	 * Deferred <system-summary> messages. Injected by onBeforeTool/onAfterTool
	 * but flushed in onBeforeThink, so they never land between an assistant
	 * tool_call message and its tool results (which breaks message pairing and
	 * buries the warnings the model should react to).
	 */
	private pendingMessages: Array<{ role: "user"; content: string }> = [];

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
		this.tracker = new PlanTracker(plan);
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
			s.status !== "done" && s.status !== "skipped"
				? [`${s.id}. ${s.description}`]
				: [],
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
					'Create, update, show, abort, list, switch, or re-plan multi-step plans.\n\nActions:\n- create: Start a new plan. Previous active plan is auto-preserved: incomplete → draft, complete → archive.\n- update: Mark step status (done/failed/skipped), or rebuild plan with new steps.\n- show: Print current plan checklist.\n- abort: Archive current plan and clear active slot.\n- list: Show all plans (active, drafts, archived) with progress.\n- switch: Make a different plan active (by plan id).\n- re-plan: Iterative replanning: keep completed steps, replace remaining with new steps.\n\nWrite CONCRETE steps with exact file paths and commands:\n- Specify WHICH files to create with exact paths (e.g. "create src/components/Header.tsx with navigation and logo")\n- Specify WHICH packages to install (e.g. "run npm install react react-dom")\n- Specify WHICH CLI commands to run with exact arguments\n- Each step should include at least one file extension (.ts, .tsx, .json, etc.) or a command verb (install, create, build, run, add, init)\n- Good: "Создать src/components/Header.tsx с навигацией и логотипом"\n- Bad: "Настройка проекта" (too vague — what exactly needs to be configured?)',
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
							],
						},
						title: { type: "string" },
						steps: { type: "array", items: { type: "string" } },
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
						const metas = this.store.listAll();
						if (metas.length === 0) {
							return { success: true, output: t("plan.list_empty") };
						}
						const lines = metas.map((m) => {
							const icon =
								m.status === "active"
									? "[*]"
									: m.status === "draft"
										? "[ ]"
										: "[-]";
							const namePart = m.name ? ` (${m.name})` : "";
							return `${icon} ${m.id}${namePart} — ${m.title}  ${m.doneCount}/${m.stepCount}`;
						});
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
						const found = this.store.find(planId);
						if (!found) {
							return {
								success: false,
								output: t("plan.not_found", { id: planId }),
							};
						}
						this.preserveActive();
						if (found.status === "draft") {
							this.store.removeDraft(found.plan.id);
						} else if (found.status === "archived") {
							this.store.removeArchived(found.plan.id);
						}
						this.setPlan(found.plan);
						const display = PlanCreator.toPromptBlock(found.plan, 0);
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
						if (!this.tracker) {
							return { success: false, output: t("plan.no_active") };
						}
						const newSteps = Array.isArray(args.steps)
							? args.steps.map(String)
							: [];
						if (newSteps.length === 0) {
							return { success: false, output: t("plan.replan_no_steps") };
						}
						const oldPlan = this.tracker.getPlan();
						const replanned = PlanCreator.replan(
							oldPlan,
							newSteps,
							args.title ? String(args.title) : undefined,
						);
						const keptCount = replanned.steps.length - newSteps.length;
						this.setPlan(replanned);
						const display = PlanCreator.toPromptBlock(replanned, keptCount);
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
						const steps = Array.isArray(args.steps)
							? args.steps.map(String)
							: [];
						if (steps.length === 0) {
							return { success: false, output: t("plan.no_steps") };
						}
						this.preserveActive();
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
						const planId = args.id ? String(args.id) : "";
						if (planId && planId !== this.tracker?.getPlan()?.id) {
							// Show a specific plan (active, draft, or archived) instead
							// of ignoring the id and always printing the active one
							// (observed: the model asked for an archived plan three
							// times and got the active plan back every time).
							const found = this.store.find(planId);
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
					const stepId = Number(args.step);
					const target = this.tracker.getStep(stepId);
					if (!target) {
						return { success: false, output: t("plan.step_not_found") };
					}
					const status = String(args.status || "done");

					// Idempotency: re-marking a done step as done usually means the
					// plan was already auto-advanced (all step files exist) and the
					// model is confirming its own work. Return SUCCESS so the loop
					// isn't confused — a small model misreads success:false as a
					// failed action and retries/spins. Genuine spinning (repeated
					// identical calls without new work) is still caught by the
					// stuck-detector's consecutive-identical-call check.
					if (status === "done" && target.status === "done") {
						const progress = this.tracker.getProgressString();
						const display = this.tracker.toPromptBlock();
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
						const blockers = this.tracker
							.getPlan()
							.steps.filter(
								(s) =>
									s.id < stepId &&
									s.status !== "done" &&
									s.status !== "skipped",
							);
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

					// Deliverable gate: marking a step done must mean its named
					// files actually exist. Without this the model could mark a
					// step done right after deleting its source file (observed in
					// ses_msstxxff: `del bicycles.ts` → `plan update step=2
					// status=done` while the file was gone) and the final audit
					// then passed because every step was self-certified done.
					if (status === "done") {
						const missing = this.missingStepDeliverables(target);
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

					this.tracker.updateStepStatus(stepId, status as any);
					if (args.note)
						this.tracker.addNote(Number(args.step), String(args.note));
					this.tracker.syncCurrentStep();
					this.store.saveActive(this.tracker.getPlan());
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
						if (this.tracker) {
							this.store.archivePlan(this.tracker.getPlan());
						}
						this.tracker = null;
						this.store.clearActive();
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
						const existing = currentStep.subtasks ?? [];
						let nextId =
							existing.reduce((m, s) => Math.max(m, s.id), 0) + 1;
						for (const item of items) {
							existing.push({ id: nextId++, text: item, done: false });
						}
						currentStep.subtasks = existing;
						this.store.saveActive(this.tracker.getPlan());
						const display = this.tracker.toPromptBlock();
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
						const items = Array.isArray(args.items)
							? args.items.map(String)
							: [];
						if (items.length === 0) {
							return {
								success: false,
								output: t("todo.no_items"),
							};
						}
						const subs = currentStep.subtasks ?? [];
						let marked = 0;
						for (const item of items) {
							const sub = subs.find(
								(s) =>
									!s.done &&
									s.text.toLowerCase() === item.toLowerCase(),
							);
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
						this.store.saveActive(this.tracker.getPlan());
						const doneCount = subs.filter((s) => s.done).length;
						const display = this.tracker.toPromptBlock();
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
				// Flush deferred <system-summary> messages first so they are visible
				// to the next model call but never interleave tool messages.
				if (ctx.contextManager && this.pendingMessages.length > 0) {
					for (const m of this.pendingMessages.splice(0)) {
						ctx.contextManager.addMessage(m);
					}
				}
				if (this.tracker?.isComplete()) {
					// All steps done/skipped — stop counting "no progress" against
					// the last step and silence step-stuck warnings for a finished
					// plan, BUT keep the tool-call history so a read-without-write
					// loop is still caught (observed: plan complete + false-positive
					// audit → the model re-read files for 50+ iterations with zero
					// writes and no recovery hint).
					this.stuckDetector.resetStepProgress();
					this.consecutivePlanWarnings = 0;
					this.lastStepId = -1;
					this.stuckNotified = false;
				} else {
					const step = this.tracker?.getCurrentStep();
					if (this.tracker && step) {
						if (step.id !== this.lastStepId) {
							this.consecutivePlanWarnings = 0;
							this.lastStepId = step.id;
							this.stuckNotified = false;
						}
						this.stuckDetector.setCurrentStep(step.id, step.description);
						this.stuckDetector.recordIteration(step.id);
					} else {
						this.stuckDetector.reset();
						this.consecutivePlanWarnings = 0;
						this.lastStepId = -1;
						this.stuckNotified = false;

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
				}
				const stuckReason = this.stuckDetector.getStuckReason();
				if (stuckReason) {
					// Log once per stuck episode instead of spamming every iteration.
					const logIt = this.stuckDetector.isStuck()
						? !this.stuckNotified
						: true;
					if (logIt) {
						ctx.logger?.warn(stuckReason);
						ctx.sessionLog?.plan(
							"stuck-warning",
							stuckReason,
							typeof ctx.iteration === "number" ? ctx.iteration : undefined,
						);
						if (this.stuckDetector.isStuck()) this.stuckNotified = true;
					}
				}
				if (
					this.stuckDetector.isStuck() ||
					this.stuckDetector.hasRepetitiveToolCalls() ||
					this.stuckDetector.hasReadOnlyLoop()
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
			onBeforeTool: (_ctx: any, call: ToolCall) => {
				const warning = this.checkPlanAlignment(call);
				if (warning) {
					this.pendingMessages.push({
						role: "user",
						content: `<system-summary>${warning}</system-summary>`,
					});
					this.consecutivePlanWarnings++;
					if (this.consecutivePlanWarnings >= MAX_PLAN_WARNINGS_BEFORE_BLOCK) {
						this.pendingMessages.push({
							role: "user",
							content: `<system-summary>${t("exec.plan_blocked", { step: String(this.tracker?.getCurrentStep()?.id ?? "?"), max: MAX_PLAN_WARNINGS_BEFORE_BLOCK })}</system-summary>`,
						});
						// Block with an explicit reason so the model sees WHY the call
						// was blocked (executor shows it via tool.blocked_reason).
						return t("exec.plan_blocked", {
							step: String(this.tracker?.getCurrentStep()?.id ?? "?"),
							max: MAX_PLAN_WARNINGS_BEFORE_BLOCK,
						});
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
				// Remember every bash invocation (successful or not) so stuck
				// detection can reason about e.g. repeated runs with empty output.
				if (call.name === "bash") {
					this.stuckDetector.recordBashOutput(
						String(call.arguments?.command ?? ""),
						String(result.output ?? ""),
					);
				}
				// A write/edit/bash that reports success but still carries a
				// type/syntax error in its output is NOT a success — the model must
				// fix the actual error, not keep rewriting the file blindly. Feed it
				// to the stuck detector so the rewrite-loop hint fires.
				const toolText = String(result.output ?? "");
				if (
					/error TS\d+|\[Project typecheck failed\]|\[Syntax check failed\]/.test(
						toolText,
					)
				) {
					this.stuckDetector.recordToolError(
						call.name,
						toolText.slice(0, 300),
					);
				}
				if (!result.success) {
					this.stuckDetector.recordToolError(call.name, result.output);

					// Immediately queue an actionable hint on failure (don't wait for
					// the stuck threshold). Flushed in onBeforeThink so it does not
					// land between tool messages.
					const actionableHints = this.stuckDetector.getActionableHints();
					const alternative = this.stuckDetector.getToolAlternative();
					if (actionableHints.length > 0 || alternative) {
						const parts = [...actionableHints];
						if (alternative) {
							parts.push(
								`Tool "${call.name}" crashed. Try "${alternative}" instead.`,
							);
						}
						this.pendingMessages.push({
							role: "user",
							content: `<system-summary>${t("exec.hints", { hints: parts.map((h) => `- ${h}`).join("\n") })}</system-summary>`,
						});
					}
				} else {
					this.stuckDetector.recordToolSuccess();

					// When a bash command runs code successfully, suggest marking the
					// step done — unless the output shows failing tests, which must
					// never be reported as a clean success.
					if (call.name === "bash" && result.success) {
						const cmd = String(call.arguments?.command ?? "");
						const testRun = detectTestResults(String(result.output ?? ""));
						if (testRun && testRun.failed > 0) {
							this.pendingMessages.push({
								role: "user",
								content: `<system-summary>${testRun.framework} reported ${testRun.failed} FAILING test(s) (${testRun.passed} passing). Do NOT mark the current step as done — fix the failing tests (read the failure output, correct the code) and re-run them until all pass.</system-summary>`,
							});
						} else if (testRun && testRun.failed === 0 && testRun.passed > 0) {
							this.pendingMessages.push({
								role: "user",
								content: `<system-summary>${testRun.framework}: all ${testRun.passed} test(s) passed for "${cmd}". You may mark the current step as done via plan update step=N status=done.</system-summary>`,
							});
						} else if (
							/node|tsx|ts-node|python|npm\s+(start|test|run)/.test(cmd)
						) {
							this.pendingMessages.push({
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

	private preserveActive(): void {
		if (!this.tracker) return;
		const plan = this.tracker.getPlan();
		if (
			plan.steps.every((s) => s.status === "done" || s.status === "skipped")
		) {
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

		const stepPaths = (
			step.description.match(/\b[\w./\\-]+\.[a-z]+/gi) || []
		).map((p) => p.toLowerCase());
		if (stepPaths.length === 0) return null;

		const argStr = JSON.stringify(call.arguments).toLowerCase();
		const callPaths = (argStr.match(/\b[\w./\\-]+\.[a-z]+/gi) || []).map((p) =>
			p.toLowerCase(),
		);

		if (callPaths.length === 0) return null;

		// Files that already belong to COMPLETED (done/skipped) steps are
		// legitimate rewrite targets — the agent iterates on them while fixing
		// LSP/type errors. Blocking those would stop normal bug-fixing.
		const plan = this.tracker.getPlan();
		const finishedPaths = new Set<string>();
		for (const s of plan.steps) {
			if (s.status === "done" || s.status === "skipped") {
				const ps =
					s.description
						.match(/\b[\w./\\-]+\.[a-z]+/gi)
						?.map((p) => p.toLowerCase()) ?? [];
				ps.forEach((p) => finishedPaths.add(p));
			}
		}

		const offPath = callPaths.some((p) => {
			if (
				finishedPaths.has(p) ||
				[...finishedPaths].some((s) => s.includes(p))
			) {
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
					const hints = this.depsGateHints.get(step.id) || 0;
					this.depsGateHints.set(step.id, hints + 1);
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
		const firstUser = history.find(
			(m: { role: string; content: string | ContentPart[] }) => {
				if (m.role !== "user") return false;
				const text = getMessageText(m.content);
				return (
					!text.startsWith("<system-summary>") &&
					!text.includes("[Compressed:")
				);
			},
		);
		if (!firstUser) return "";
		return getMessageText(firstUser.content).trim();
	}
}
