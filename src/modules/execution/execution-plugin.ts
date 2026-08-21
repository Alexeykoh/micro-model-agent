import type { AgentPlugin } from "../types";
import type { ToolCall } from "../../tools/types";
import { t } from "../../i18n/index";
import { StuckDetector } from "./stuck-detector";
import type { PlanTracker } from "./tracker";
import type { PlanStore } from "./plan-store";
import { detectTestResults } from "../../tools/bash";
import { forbiddenWindowsCommand } from "./windows-commands";
import { extractFileLikeTokens, stripUrls } from "../hallucination/js-identifiers";
import { platform } from "os";

/**
 * Cooldown (in iterations) between stuck-recovery injections. Exported so the
 * ExecutionModule can seed its state's lastRecoveryIteration with the same
 * offset the plugin compares against.
 */
export const STUCK_RECOVERY_COOLDOWN = 5;
const MAX_PLAN_WARNINGS_BEFORE_BLOCK = 3;
const FORCE_SKIP_THRESHOLD = 10;
/** How many file-mutating tool calls (write/edit/bash/download) without an
 *  active plan trigger the plan-creation nudge. Evidence-based (rule #10):
 *  the agent is clearly working on files, so a plan is warranted. */
const PLAN_NUDGE_THRESHOLD = 2;

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
  /** write/edit/bash/download calls made while NO plan is active. */
  mutationsWithoutPlan: number;
  /** Whether the plan-creation nudge has already been injected. */
  planNudgeSent: boolean;
  /**
   * Files the last write/edit reported as failing the project typecheck or a
   * syntax check, mapped to the first error line. Cleared by a clean
   * write/edit result (the debounced project tsc re-ran and passed). The plan
   * done-gate refuses "done" while a step's files are still in here.
   */
  typecheckFailures: Map<string, string>;
}

export interface ExecutionPluginDeps {
  stuckDetector: StuckDetector;
  trackerRef: { readonly current: PlanTracker | null };
  pendingMessages: Array<{ role: "user"; content: string }>;
  forbiddenBashFailures: Map<string, number>;
  state: ExecutionPluginState;
  store: PlanStore;
  checkPlanAlignment(call: any): string | null;
  advancePlanIfStepComplete(
    contextManager?: any,
    sessionLog?: {
      plan(event: string, detail: string, iteration?: number): void;
    },
  ): void;
  maybeSearchError: (ctx: any, call: any) => void;
}

/** A compile failure attributed to a file ("" = no file anchor). */
export interface BrokenFile {
  file: string;
  error: string;
}

function normalizeBrokenPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Parse a tsc / bun build / node --check error line into its file path.
 *  Returns null when the line carries no file anchor (e.g. `error: Could not
 *  resolve "..."`). */
export function parseBrokenFile(line: string): string | null {
  const trimmed = line.trim();
  // tsc: src/index.tsx(17,15): error TS2322: ...
  const tsc = /^(.+?)\s*\(\d+,\d+\)\s*:\s*error TS\d+/.exec(trimmed);
  if (tsc) return normalizeBrokenPath(tsc[1]);
  // bun build / node --check: /abs/file.tsx:1:10: error: ...
  const bn = /^(.+?):\d+:\d+\s*:\s*(?:error|SyntaxError)/.exec(trimmed);
  if (bn) return normalizeBrokenPath(bn[1]);
  return null;
}

/** Extract per-file compile failures from a write/edit result output. Only
 *  the marker lines are inspected (`[Project typecheck failed]: <line>` /
 *  `[Syntax check failed]: <line>`) so a diff body can never false-positive. */
export function extractBrokenFiles(output: string): BrokenFile[] {
  const out: BrokenFile[] = [];
  for (const line of output.split("\n")) {
    const marker = /\[(?:Project typecheck failed|Syntax check failed)\]:\s*(.+)$/.exec(line);
    if (!marker) continue;
    const errLine = marker[1].trim();
    out.push({ file: parseBrokenFile(errLine) ?? "", error: errLine.slice(0, 300) });
  }
  return out;
}

/**
 * Gate for `plan update status=done`: refuse while the last write/edit still
 * reports a compile error. A failure with no file anchor blocks the whole
 * project; otherwise a step's named file tokens are matched against the
 * broken files (path-suffix match, case-insensitive). A step naming no files
 * cannot be blamed — its done stays vacuous. Returns the first error to show
 * the model, or null to allow the done.
 */
export function stepTypecheckGate(
  failures: ReadonlyMap<string, string>,
  stepDescription: string,
): string | null {
  if (failures.size === 0) return null;
  const projectError = failures.get("");
  if (projectError) return projectError;
  const stepTokens = extractFileLikeTokens(stripUrls(stepDescription)).map((p) =>
    normalizeBrokenPath(p).toLowerCase(),
  );
  if (stepTokens.length === 0) return null;
  for (const [file, err] of failures) {
    const f = normalizeBrokenPath(file).toLowerCase();
    if (stepTokens.some((tok) => f.endsWith(tok) || tok.endsWith(f))) return err;
  }
  return null;
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
        deps.state.mutationsWithoutPlan = 0;
        deps.state.planNudgeSent = false;
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
          // A plan is active — any mutation counter no longer applies.
          deps.state.mutationsWithoutPlan = 0;
          deps.state.planNudgeSent = false;
        } else {
          deps.stuckDetector.reset();
          deps.state.consecutivePlanWarnings = 0;
          deps.state.lastStepId = -1;
          deps.state.stuckNotified = false;

          // Evidence-based plan nudge (rule #10 — no bare iteration counter,
          // no keyword task classification): only after the agent actually
          // made file-mutating tool calls (write/edit/bash/download) without
          // a plan does the agent need a plan.
          const mutations = deps.state.mutationsWithoutPlan;
          if (
            mutations >= PLAN_NUDGE_THRESHOLD &&
            !deps.state.planNudgeSent &&
            ctx.contextManager
          ) {
            deps.state.planNudgeSent = true;
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.plan_nudge", {
                count: String(mutations),
              })}</system-summary>`,
            });
          }
        }
      }
      const stuckReason = deps.stuckDetector.getStuckReason();
      if (stuckReason) {
        // Log once per stuck episode instead of spamming every iteration.
        const logIt = deps.stuckDetector.isStuck() ? !deps.state.stuckNotified : true;
        if (logIt) {
          ctx.logger?.warn(stuckReason);
          ctx.sessionLog?.plan(
            "stuck-warning",
            stuckReason,
            typeof ctx.iteration === "number" ? ctx.iteration : undefined,
          );
          if (deps.stuckDetector.isStuck()) deps.state.stuckNotified = true;
        }
      }
      if (
        deps.stuckDetector.isStuck() ||
        deps.stuckDetector.hasRepetitiveToolCalls() ||
        deps.stuckDetector.hasReadOnlyLoop()
      ) {
        const currentIter = typeof ctx.iteration === "number" ? ctx.iteration : 0;
        if (currentIter - deps.state.lastRecoveryIteration >= STUCK_RECOVERY_COOLDOWN) {
          const recovery = deps.stuckDetector.getRecoveryMessage();
          if (recovery && ctx.contextManager) {
            // Include tsc error context so the model knows WHY it is stuck.
            let tscContext = "";
            if (deps.state.typecheckFailures.size > 0) {
              const currentStep = deps.trackerRef.current?.getCurrentStep();
              if (currentStep) {
                const stepFiles = extractFileLikeTokens(stripUrls(currentStep.description));
                for (const [file, error] of deps.state.typecheckFailures) {
                  if (!file || stepFiles.some((f) => file.endsWith(f) || f.endsWith(file))) {
                    tscContext = `\nLast compile error: ${error}`;
                    break;
                  }
                }
                if (!tscContext) {
                  const first = deps.state.typecheckFailures.entries().next().value;
                  if (first) tscContext = `\nLast compile error: ${first[1]}`;
                }
              }
            }

            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>${recovery}${tscContext}</system-summary>`,
            });
          }
          deps.stuckDetector.recordEscalation();
          deps.state.lastRecoveryIteration = currentIter;

          if (deps.stuckDetector.shouldEscalate() && ctx.onMeta) {
            const escalation = t("exec.escalation", {
              stepId: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"),
              description: deps.trackerRef.current?.getCurrentStep()?.description ?? "",
            });
            ctx.onMeta(escalation);
          }

          // Force skip after too many iterations on the same step
          if (
            deps.stuckDetector.getIterationsOnCurrentStep() >= FORCE_SKIP_THRESHOLD &&
            ctx.contextManager
          ) {
            const step = deps.trackerRef.current?.getCurrentStep();
            ctx.contextManager.addMessage({
              role: "user",
              content: `<system-summary>${t("exec.stop_directive", {
                stepId: String(step?.id ?? "?"),
                description: step?.description ?? "",
                iterations: String(deps.stuckDetector.getIterationsOnCurrentStep()),
              })}</system-summary>`,
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
        if (deps.state.consecutivePlanWarnings >= MAX_PLAN_WARNINGS_BEFORE_BLOCK) {
          deps.pendingMessages.push({
            role: "user",
            content: `<system-summary>${t("exec.plan_blocked", { step: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"), max: MAX_PLAN_WARNINGS_BEFORE_BLOCK })}</system-summary>`,
          });
          // Block with an explicit reason so the model sees WHY the call
          // was blocked (executor shows it via tool.blocked_reason).
          return t("exec.plan_blocked", {
            step: String(deps.trackerRef.current?.getCurrentStep()?.id ?? "?"),
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
        // Count file-mutating calls made with NO active plan — feeds the
        // evidence-based plan-creation nudge in onBeforeThink.
        if (
          !deps.trackerRef.current &&
          (toolName === "write_file" ||
            toolName === "edit_file" ||
            toolName === "bash" ||
            toolName === "download_file")
        ) {
          deps.state.mutationsWithoutPlan++;
        }
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
      // Auto-detect delete intent from model actions: when delete_file is
      // called, find the matching plan step and set kind="delete". This is
      // language-agnostic — based on what the model DID, not what it said.
      if (call.name === "delete_file" && result.success && deps.trackerRef.current) {
        const deletedPath = String(call.arguments?.path ?? "");
        if (deletedPath) {
          const plan = deps.trackerRef.current.getPlan();
          const tokens = extractFileLikeTokens(stripUrls(deletedPath));
          for (const step of plan.steps) {
            if (step.status !== "pending" && step.status !== "in_progress") continue;
            const stepTokens = extractFileLikeTokens(stripUrls(step.description));
            const overlap = tokens.some((t) =>
              stepTokens.some((st) => t.endsWith(st) || st.endsWith(t)),
            );
            if (overlap && step.kind !== "delete") {
              step.kind = "delete";
              deps.store.saveActive(plan);
              break;
            }
          }
        }
      }
      // A write/edit/bash that reports success but still carries a
      // type/syntax error in its output is NOT a success — the model must
      // fix the actual error, not keep rewriting the file blindly. Feed it
      // to the stuck detector so the rewrite-loop hint fires.
      const toolText = String(result.output ?? "");
      const hasTypeError = /error TS\d+|\[Project typecheck failed\]|\[Syntax check failed\]/.test(
        toolText,
      );
      if (hasTypeError) {
        deps.stuckDetector.recordToolError(call.name, toolText.slice(0, 300));
      }
      // Track compile failures per-file so the plan done-gate can refuse
      // "done" while the last edit still doesn't compile (observed: the agent
      // marked plan steps done while the project typecheck failed on every
      // write — a "fix it later" cascade). A CLEAN result clears the map: the
      // debounced project tsc re-ran and passed (or no tsconfig applies), so
      // old failures must not block completion forever.
      if (call.name === "write_file" || call.name === "edit_file") {
        const broken = extractBrokenFiles(toolText);
        if (broken.length > 0) {
          for (const b of broken) deps.state.typecheckFailures.set(b.file, b.error);
        } else if (result.success) {
          deps.state.typecheckFailures.clear();
        }
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
            const n = (deps.forbiddenBashFailures.get(forbidden) || 0) + 1;
            deps.forbiddenBashFailures.set(forbidden, n);
            if (n === 2) {
              deps.pendingMessages.push({
                role: "user",
                content: `<system-summary>${t("exec.forbidden_cmd", { cmd: forbidden })}</system-summary>`,
              });
            }
          }
        }
        // A type/syntax error in an otherwise "successful" result was already
        // recorded above. A failing call (result.success === false) would
        // otherwise double-count the same error (typecheck branch + failure
        // branch), inflating the error-signature count and triggering the
        // web search at half the intended threshold.
        if (!hasTypeError) {
          deps.stuckDetector.recordToolError(call.name, result.output);
        }
      } else {
        deps.stuckDetector.recordToolSuccess();

        // When a bash command runs code successfully, suggest marking the
        // step done — unless the output shows failing tests, which must
        // never be reported as a clean success.
        if (call.name === "bash" && result.success) {
          const cmd = String(call.arguments?.command ?? "");
          const testRun = detectTestResults(String(result.output ?? ""));
          if (testRun && testRun.failed > 0) {
            deps.pendingMessages.push({
              role: "user",
              content: `<system-summary>${testRun.framework} reported ${testRun.failed} FAILING test(s) (${testRun.passed} passing). Do NOT mark the current step as done — fix the failing tests (read the failure output, correct the code) and re-run them until all pass.</system-summary>`,
            });
          } else if (testRun && testRun.failed === 0 && testRun.passed > 0) {
            deps.pendingMessages.push({
              role: "user",
              content: `<system-summary>${testRun.framework}: all ${testRun.passed} test(s) passed for "${cmd}". You may mark the current step as done via plan update step=N status=done.</system-summary>`,
            });
          }
        }
      }

      if (result.success && (call.name === "write_file" || call.name === "edit_file")) {
        const filePath = call.arguments?.path as string;
        if (filePath) {
          deps.stuckDetector.recordFileRewrite(filePath);
          if (deps.stuckDetector.hasExcessiveRewrites()) {
            const file = deps.stuckDetector.getExcessiveRewriteFile();
            const count = deps.stuckDetector.getFileRewriteCount(file!);
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
        deps.advancePlanIfStepComplete(ctx.contextManager, ctx.sessionLog);
      }

      // Automatic web search for a repeatedly failing error (fire-and-forget,
      // results land in pendingMessages on the next onBeforeThink flush).
      deps.maybeSearchError(ctx, call);
    },
  };
}
