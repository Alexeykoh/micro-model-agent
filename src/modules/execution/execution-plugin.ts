import type { AgentPlugin } from "../types";
import type { ToolCall } from "../../tools/types";
import { t } from "../../i18n/index";
import { StuckDetector } from "./stuck-detector";
import type { PlanTracker } from "./tracker";
import { detectTestResults } from "../../tools/bash";
import { forbiddenWindowsCommand } from "./windows-commands";
import { platform } from "os";

/**
 * Cooldown (in iterations) between stuck-recovery injections. Exported so the
 * ExecutionModule can seed its state's lastRecoveryIteration with the same
 * offset the plugin compares against.
 */
export const STUCK_RECOVERY_COOLDOWN = 5;
const MAX_PLAN_WARNINGS_BEFORE_BLOCK = 3;
const FORCE_SKIP_THRESHOLD = 10;

/**
 * Mutable state the plugin writes into. The module OWNS this object and passes
 * it by reference — every assignment here must be visible to the module.
 */
export interface ExecutionPluginState {
	lastRecoveryIteration: number;
	consecutivePlanWarnings: number;
	lastStepId: number;
	stuckNotified: boolean;
	depsGateHints: Map<number, number>;
}

export interface ExecutionPluginDeps {
	stuckDetector: StuckDetector;
	trackerRef: { readonly current: PlanTracker | null };
	pendingMessages: Array<{ role: "user"; content: string }>;
	forbiddenBashFailures: Map<string, number>;
	state: ExecutionPluginState;
	checkPlanAlignment(call: any): string | null;
	advancePlanIfStepComplete(
		contextManager?: any,
		sessionLog?: {
			plan(event: string, detail: string, iteration?: number): void;
		},
	): void;
}

/**
 * The execution plugin hooks, extracted verbatim from ExecutionModule.getPlugin().
 * All shared mutable state (pendingMessages, forbiddenBashFailures, state,
 * tracker) is owned by the module and mutated by reference through `deps`.
 */
export function createExecutionPlugin(deps: ExecutionPluginDeps): AgentPlugin {
	return {
		name: "execution",
		onBeforeThink: (ctx: any) => {
			// Flush deferred <system-summary> messages first so they are visible
			// to the next model call but never interleave tool messages.
			if (ctx.contextManager && deps.pendingMessages.length > 0) {
				for (const m of deps.pendingMessages.splice(0)) {
					ctx.contextManager.addMessage(m);
				}
			}
			if (deps.trackerRef.current?.isComplete()) {
				// All steps done/skipped — stop counting "no progress" against
				// the last step and silence step-stuck warnings for a finished
				// plan, BUT keep the tool-call history so a read-without-write
				// loop is still caught (observed: plan complete + false-positive
				// audit → the model re-read files for 50+ iterations with zero
				// writes and no recovery hint).
				deps.stuckDetector.resetStepProgress();
				deps.state.consecutivePlanWarnings = 0;
				deps.state.lastStepId = -1;
				deps.state.stuckNotified = false;
			} else {
				const step = deps.trackerRef.current?.getCurrentStep();
				if (deps.trackerRef.current && step) {
					if (step.id !== deps.state.lastStepId) {
						deps.state.consecutivePlanWarnings = 0;
						deps.state.lastStepId = step.id;
						deps.state.stuckNotified = false;
					}
					deps.stuckDetector.setCurrentStep(step.id, step.description);
					deps.stuckDetector.recordIteration(step.id);
				} else {
					deps.stuckDetector.reset();
					deps.state.consecutivePlanWarnings = 0;
					deps.state.lastStepId = -1;
					deps.state.stuckNotified = false;

					const iter: number =
						typeof ctx.iteration === "number" ? ctx.iteration : 0;
					if (
						iter === 3 &&
						!deps.trackerRef.current &&
						ctx.contextManager
					) {
						ctx.contextManager.addMessage({
							role: "user",
							content: `<system-summary>You have made 3 tool calls without creating a plan. For any task that involves creating files, installing packages, or multiple steps — you MUST use plan create BEFORE continuing. Use the plan tool now with concrete steps (exact filenames, commands, deliverables). Do NOT make any more write/edit/bash calls until you have a plan.</system-summary>`,
						});
					}
					if (
						iter >= 6 &&
						!deps.trackerRef.current &&
						ctx.contextManager
					) {
						ctx.contextManager.addMessage({
							role: "user",
							content: `<system-summary>STOP. ${iter} iterations without a plan. You MUST call plan create RIGHT NOW. No more tool calls until you create a plan.</system-summary>`,
						});
					}
				}
			}
			const stuckReason = deps.stuckDetector.getStuckReason();
			if (stuckReason) {
				// Log once per stuck episode instead of spamming every iteration.
				const logIt = deps.stuckDetector.isStuck()
					? !deps.state.stuckNotified
					: true;
				if (logIt) {
					ctx.logger?.warn(stuckReason);
					ctx.sessionLog?.plan(
						"stuck-warning",
						stuckReason,
						typeof ctx.iteration === "number"
							? ctx.iteration
							: undefined,
					);
					if (deps.stuckDetector.isStuck())
						deps.state.stuckNotified = true;
				}
			}
			if (
				deps.stuckDetector.isStuck() ||
				deps.stuckDetector.hasRepetitiveToolCalls() ||
				deps.stuckDetector.hasReadOnlyLoop()
			) {
				const currentIter =
					typeof ctx.iteration === "number" ? ctx.iteration : 0;
				if (
					currentIter - deps.state.lastRecoveryIteration >=
					STUCK_RECOVERY_COOLDOWN
				) {
					const recovery = deps.stuckDetector.getRecoveryMessage();
					if (recovery && ctx.contextManager) {
						const lastError =
							deps.stuckDetector.getLastErrorOutput();
						const skillHint = lastError
							? "\nIf you have relevant skills available, consider loading one with load_skill for expert guidance."
							: "";

						// Actionable hints based on actual error output
						const actionableHints =
							deps.stuckDetector.getActionableHints();
						const actionableHintStr =
							actionableHints.length > 0
								? `\n${t("exec.hints", { hints: actionableHints.map((h) => `- ${h}`).join("\n") })}`
								: "";

						// Tool alternative suggestion
						const alternative =
							deps.stuckDetector.getToolAlternative();
						const altHint = alternative
							? `\nTool "${deps.stuckDetector.getLastFailedTool()}" is failing. Try "${alternative}" instead.`
							: "";

						ctx.contextManager.addMessage({
							role: "user",
							content: `<system-summary>${recovery}${skillHint}${actionableHintStr}${altHint}</system-summary>`,
						});
					}
					const hints = deps.stuckDetector.getHints();
					if (hints.length > 0 && ctx.contextManager) {
						const hintMsg = t("exec.hints", {
							hints: hints.map((h) => `- ${h}`).join("\n"),
						});
						ctx.contextManager.addMessage({
							role: "user",
							content: `<system-summary>${hintMsg}</system-summary>`,
						});
					}
					deps.stuckDetector.recordEscalation();
					deps.state.lastRecoveryIteration = currentIter;

					if (deps.stuckDetector.shouldEscalate() && ctx.onMeta) {
						const escalation = t("exec.escalation", {
							stepId: String(
								deps.trackerRef.current?.getCurrentStep()?.id ??
									"?",
							),
							description:
								deps.trackerRef.current?.getCurrentStep()
									?.description ?? "",
						});
						ctx.onMeta(escalation);
					}

					// Force skip after too many iterations on the same step
					if (
						deps.stuckDetector.getIterationsOnCurrentStep() >=
							FORCE_SKIP_THRESHOLD &&
						ctx.contextManager
					) {
						const step = deps.trackerRef.current?.getCurrentStep();
						ctx.contextManager.addMessage({
							role: "user",
							content: `<system-summary>STOP. Step ${step?.id ?? "?"} ("${step?.description ?? ""}") took ${deps.stuckDetector.getIterationsOnCurrentStep()} iterations with no progress. DO NOT continue this step. Immediately call: plan update step=${step?.id ?? "?"} status=done (if code works despite warnings) OR plan update step=${step?.id ?? "?"} status=skipped note="reason". Do NOT make any other tool calls before updating the plan.</system-summary>`,
						});
					}
				}
			}
		},
		onBeforeTool: (_ctx: any, call: ToolCall) => {
			const warning = deps.checkPlanAlignment(call);
			if (warning) {
				deps.pendingMessages.push({
					role: "user",
					content: `<system-summary>${warning}</system-summary>`,
				});
				deps.state.consecutivePlanWarnings++;
				if (
					deps.state.consecutivePlanWarnings >=
					MAX_PLAN_WARNINGS_BEFORE_BLOCK
				) {
					deps.pendingMessages.push({
						role: "user",
						content: `<system-summary>${t("exec.plan_blocked", { step: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"), max: MAX_PLAN_WARNINGS_BEFORE_BLOCK })}</system-summary>`,
					});
					// Block with an explicit reason so the model sees WHY the call
					// was blocked (executor shows it via tool.blocked_reason).
					return t("exec.plan_blocked", {
						step: String(
							deps.trackerRef.current?.getCurrentStep()?.id ?? "?",
						),
						max: MAX_PLAN_WARNINGS_BEFORE_BLOCK,
					});
				}
			} else {
				deps.state.consecutivePlanWarnings = 0;
			}
			return true;
		},
		onToolCall: (ctx: any) => {
			const toolName = ctx?.toolName as string;
			const args = ctx?.args as Record<string, unknown>;
			if (toolName && args) {
				deps.stuckDetector.recordToolCall(toolName, args);
			}
		},
		onAfterTool: (ctx: any, call: any, result: any) => {
			// Remember every bash invocation (successful or not) so stuck
			// detection can reason about e.g. repeated runs with empty output.
			if (call.name === "bash") {
				deps.stuckDetector.recordBashOutput(
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
				deps.stuckDetector.recordToolError(
					call.name,
					toolText.slice(0, 300),
				);
			}
			if (!result.success) {
				// Hard stop for forbidden Windows commands: after the second
				// failure of the same forbidden command (grep/sed/ls/find/…),
				// inject a STOP message so the session stops burning bash calls
				// on commands cmd.exe does not have. Mirrors the bash tool's own
				// win32-gated hard-stop (src/tools/bash.ts) — on macOS/Linux
				// these commands exist and fail for legit reasons.
				if (call.name === "bash" && platform() === "win32") {
					const cmd = String(call.arguments?.command ?? "");
					const forbidden = forbiddenWindowsCommand(cmd);
					if (forbidden) {
						const n =
							(deps.forbiddenBashFailures.get(forbidden) || 0) + 1;
						deps.forbiddenBashFailures.set(forbidden, n);
						if (n === 2) {
							deps.pendingMessages.push({
								role: "user",
								content: `<system-summary>${t("exec.forbidden_cmd", { cmd: forbidden })}</system-summary>`,
							});
						}
					}
				}
				deps.stuckDetector.recordToolError(call.name, result.output);

				// Immediately queue an actionable hint on failure (don't wait for
				// the stuck threshold). Flushed in onBeforeThink so it does not
				// land between tool messages.
				const actionableHints = deps.stuckDetector.getActionableHints();
				const alternative = deps.stuckDetector.getToolAlternative();
				if (actionableHints.length > 0 || alternative) {
					const parts = [...actionableHints];
					if (alternative) {
						parts.push(
							`Tool "${call.name}" crashed. Try "${alternative}" instead.`,
						);
					}
					deps.pendingMessages.push({
						role: "user",
						content: `<system-summary>${t("exec.hints", { hints: parts.map((h) => `- ${h}`).join("\n") })}</system-summary>`,
					});
				}
			} else {
				deps.stuckDetector.recordToolSuccess();

				// When a bash command runs code successfully, suggest marking the
				// step done — unless the output shows failing tests, which must
				// never be reported as a clean success.
				if (call.name === "bash" && result.success) {
					const cmd = String(call.arguments?.command ?? "");
					const testRun = detectTestResults(
						String(result.output ?? ""),
					);
					if (testRun && testRun.failed > 0) {
						deps.pendingMessages.push({
							role: "user",
							content: `<system-summary>${testRun.framework} reported ${testRun.failed} FAILING test(s) (${testRun.passed} passing). Do NOT mark the current step as done — fix the failing tests (read the failure output, correct the code) and re-run them until all pass.</system-summary>`,
						});
					} else if (
						testRun &&
						testRun.failed === 0 &&
						testRun.passed > 0
					) {
						deps.pendingMessages.push({
							role: "user",
							content: `<system-summary>${testRun.framework}: all ${testRun.passed} test(s) passed for "${cmd}". You may mark the current step as done via plan update step=N status=done.</system-summary>`,
						});
					} else if (
						/node|tsx|ts-node|python|npm\s+(start|test|run)/.test(
							cmd,
						)
					) {
						deps.pendingMessages.push({
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
					deps.stuckDetector.recordFileRewrite(filePath);
					if (deps.stuckDetector.hasExcessiveRewrites()) {
						const file = deps.stuckDetector.getExcessiveRewriteFile();
						const count =
							deps.stuckDetector.getFileRewriteCount(file!);
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
				deps.advancePlanIfStepComplete(
					ctx.contextManager,
					ctx.sessionLog,
				);
			}
		},
	};
}
