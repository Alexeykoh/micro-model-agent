import type { AgentModule } from "../types";
import type { PromptBlock } from "../../core/types";
import type { ToolDefinition, ToolContext, ToolCall } from "../../tools/types";
import type { AgentPlugin } from "../types";
import { t } from "../../i18n/index";
import { PlanTracker } from "./tracker";
import { StepVerifier } from "./verifier";
import { StuckDetector, isSearchableError, buildSearchQuery } from "./stuck-detector";
import { Auditor, findExistingFile } from "./auditor";
import { PlanStore } from "./plan-store";
import { getMessageText } from "../../llm/provider";
import type { ContentPart } from "../../llm/provider";
import type { Plan, StepKind } from "./planner";
import { extractFileLikeTokens, stripUrls } from "../hallucination/js-identifiers";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { NetworkSecurityConfig } from "../../config/types";
import { performWebSearch, type SearchResult } from "../../tools/web-search";
import { getSessionSecurityConfig } from "../security/session-isolation";
import { createPlanToolDefinitions } from "./plan-tool";
import {
  createExecutionPlugin,
  STUCK_RECOVERY_COOLDOWN,
  STUCK_WARN_REPEAT_EVERY,
  type ExecutionPluginState,
} from "./execution-plugin";

/**
 * Injectable search runner. Defaults to performWebSearch (shared with the
 * web_search tool) so tests can substitute a mock. `requestTimeoutMs` lets
 * the caller override the network timeout (errorWebSearch.requestTimeoutMs).
 */
export type WebSearchRunner = (
  query: string,
  numResults: number,
  networkConfig: NetworkSecurityConfig | undefined,
  requestTimeoutMs?: number,
) => Promise<{ success: boolean; results: SearchResult[]; error?: string; blocked?: boolean }>;

/**
 * Minimum interval between automatic error searches. The spec asked for a
 * STUCK_RECOVERY_COOLDOWN-iteration cap, but onAfterTool has no iteration
 * counter (executor context), so the same anti-spam protection is
 * time-based. Injectable via the constructor for tests (0 disables it).
 */
const ERROR_SEARCH_MIN_INTERVAL_MS = 30000;

/**
 * Tools that may run while a plan step is active WITHOUT a step-alignment
 * check. They either cannot touch the filesystem, or are structural/read-only
 * inspection tools the agent legitimately needs at any point (diagnostics,
 * index/search, memory, process introspection, interactive prompts). Only
 * file-mutating tools are pinned to the current step's file tokens.
 *
 * `lsp_check` and `project_map` belong here explicitly: both are alwaysOn and
 * the system prompt MANDATES `lsp_check` after every write (including rewrites
 * of files owned by already-completed steps). Leaving them off the list made
 * every diagnostic call burn a plan warning and could hard-block a legitimate
 * write on the 3rd call (observed: "3 вызовов подряд вне текущего шага" while
 * the agent was writing the current step's own deliverable).
 */
const PLAN_ALIGNMENT_EXEMPT_TOOLS = new Set([
  // structural / execution control
  "plan",
  "todo",
  "verify",
  "enable_tools",
  // filesystem reads
  "list_dir",
  "read_file",
  "glob",
  "grep",
  "file_info",
  // read-only diagnostics + code index
  "lsp_check",
  "project_map",
  "chunk_query",
  // web / memory / session reads
  "web_search",
  "web_fetch",
  "web_browse",
  "recall",
  "search_history",
  "session_info",
  // process introspection
  "process_list",
  "process_log",
  // interactive prompts (no filesystem mutation)
  "question",
  "approve",
  // skills
  "load_skill",
]);

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
   * The last plan that was COMPLETED and auto-archived. `plan update` on the
   * final step clears the tracker, which used to make runFinalAudit() return
   * null and silently skip the final audit (tests + tsc + file checks) for a
   * finished task. Keep the completed plan so the audit gate still runs.
   */
  private completedPlan: Plan | null = null;
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
  private searchRunner: WebSearchRunner;
  private webSearchThreshold: number;
  private searchesThisSession = 0;
  private retryWebSearchSignatures = new Set<string>();
  private lastErrorSearchAt = 0;
  private readonly errorSearchCooldownMs: number;
  private hallucinationDetector: { getConsistencyCheck(): { getDeletedFiles(): string[] } } | null =
    null;

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
    lastStuckWarnKey: "",
    lastStuckWarnIter: -STUCK_WARN_REPEAT_EVERY,
    depsGateHints: new Map<number, number>(),
    mutationsWithoutPlan: 0,
    planNudgeSent: false,
    typecheckFailures: new Map<string, string>(),
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

  constructor(
    baseDir: string,
    stuckThreshold = 6,
    webSearchThreshold = 5,
    searchRunner: WebSearchRunner = performWebSearch,
    errorSearchCooldownMs = ERROR_SEARCH_MIN_INTERVAL_MS,
  ) {
    this.baseDir = baseDir;
    this.verifier = new StepVerifier(baseDir);
    this.stuckDetector = new StuckDetector(stuckThreshold, 3, webSearchThreshold);
    this.auditor = new Auditor(baseDir);
    this.store = new PlanStore(baseDir);
    this.webSearchThreshold = webSearchThreshold;
    this.searchRunner = searchRunner;
    this.errorSearchCooldownMs = errorSearchCooldownMs;
  }

  setPlan(plan: Plan): void {
    this.tracker = new PlanTracker(plan);
    // Advance the pointer past any done/skipped steps of a restored/replanned
    // plan so display ("current: step N") and the off-track alignment match
    // reality instead of always pointing at step 1.
    this.tracker.syncCurrentStep();
    this.store.saveActive(plan);
    this.completedPlan = null; // a new plan supersedes the completed one
    this._auditSkipsRemaining = 0; // plan explicitly created — arm the audit gate
  }

  /** Wire the hallucination detector so the plan tool can check whether
   *  a file was tracked as deleted (auto-switch kind gate). */
  setHallucinationDetector(detector: {
    getConsistencyCheck(): { getDeletedFiles(): string[] };
  }): void {
    this.hallucinationDetector = detector;
  }

  /** Remember the last completed plan so the final audit can still verify it
   *  after the tracker was cleared by the auto-archive. */
  recordCompleted(plan: Plan): void {
    this.completedPlan = plan;
  }

  /** Forget the completed plan (abort/delete/purge — nothing left to audit). */
  clearCompleted(): void {
    this.completedPlan = null;
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

  /** The currently tracked plan (single source of truth for UI consumers).
   *  Null in a fresh session — a disk-resident plan is restored only when
   *  resuming a session with history, so the REPL must never see stale plans. */
  getActivePlan(): Plan | null {
    return this.tracker?.getPlan() ?? null;
  }

  getStore(): PlanStore {
    return this.store;
  }

  getStuckDetector(): StuckDetector {
    return this.stuckDetector;
  }

  /**
   * Automatic web search for a repeatedly failing error (>= errorWebSearch.threshold
   * identical signatures). Fires the search fire-and-forget (never blocks the tool
   * result) and queues the results as a <system-summary> in pendingMessages.
   *
   * Gates: webSearch master switch + errorWebSearch switch → repeated signature
   * → not-searched (or retried) → session cap → meaningful error text →
   * cooldown. One search per signature; empty results trigger a single retry
   * (unmarkErrorSearched once), then the signature stays searched.
   */
  maybeSearchError(ctx: ToolContext, call: ToolCall): void {
    if (ctx.config?.webSearch?.enabled === false) return;
    const cfg = ctx.config?.errorWebSearch;
    if (!cfg?.enabled) return;
    const sig = this.stuckDetector.getRepeatedErrorSignature();
    if (!sig) return;
    if (this.stuckDetector.hasErrorSearched(sig) && !this.retryWebSearchSignatures.has(sig)) return;
    if (this.searchesThisSession >= (cfg.maxSearchesPerSession ?? 3)) return;
    const lastError = this.stuckDetector.getLastErrorOutput();
    if (!isSearchableError(lastError)) {
      ctx.logger?.debug(t("exec.error_search_no_query"));
      return;
    }
    const now = Date.now();
    if (now - this.lastErrorSearchAt < this.errorSearchCooldownMs) return;
    const stepDesc = this.tracker?.getCurrentStep()?.description ?? "";
    const query = buildSearchQuery(
      stepDesc,
      this.stuckDetector.getLastBashCommand(),
      lastError,
      call.name,
      cfg.maxQueryChars ?? 200,
    );
    const count = this.stuckDetector.getErrorSignatureCount(sig);
    this.stuckDetector.markErrorSearched(sig);
    this.searchesThisSession++;
    this.lastErrorSearchAt = now;
    const networkConfig = getSessionSecurityConfig(ctx.config, ctx.sessionContext).network;
    this.searchRunner(query, cfg.maxResults ?? 5, networkConfig, cfg.requestTimeoutMs ?? 10000)
      .then((res) => {
        if (!res.success || res.results.length === 0) {
          if (!this.retryWebSearchSignatures.has(sig)) {
            this.retryWebSearchSignatures.add(sig);
            this.stuckDetector.unmarkErrorSearched(sig);
          }
          ctx.logger?.warn(t("exec.error_search_failed", { query }));
          ctx.sessionLog?.plan("web-search", `empty/failed: ${query}`);
          return;
        }
        const resultsText = res.results
          .map((r, i) => `${i + 1}. ${r.title} \u2014 ${r.url}\n   ${r.snippet}`)
          .join("\n");
        this.pendingMessages.push({
          role: "user",
          content: `<system-summary>${t("exec.error_search_results", {
            sig,
            count: String(count),
            query,
            results: resultsText,
          })}</system-summary>`,
        });
      })
      .catch((e) => ctx.logger?.warn(`error web search: ${e.message}`));
  }

  /**
   * Final audit before the agent may declare the task done. Returns null when
   * no plan is active; otherwise checks plan completion + artifact existence.
   */
  /**
   * Evidence-based auto-close of pending plan steps whose deliverables exist
   * on disk. Small models routinely finish the actual work but forget the
   * `plan update` bookkeeping (observed ses_mthn3c2a: 2/5 steps marked done
   * while every artifact existed — the audit gate then rejected a correct
   * final answer and burned all retry budget on bookkeeping, not on work).
   *
   * Standard is the SAME one the auditor already applies to done steps: every
   * file-like token in the step description resolves to an existing file.
   * Steps without any file token stay pending (nothing to verify).
   */
  private autoCloseEvidenceSteps(plan: Plan): number {
    let closed = 0;
    for (const step of plan.steps) {
      if (step.status === "done" || step.status === "skipped") continue;
      const tokens = extractFileLikeTokens(stripUrls(step.description));
      if (tokens.length === 0) continue;
      const allExist = tokens.every((f) => findExistingFile(this.baseDir, f) !== null);
      if (!allExist) continue;
      step.status = "done";
      step.note = `auto-closed by final audit: all named files exist (${tokens.join(", ")})`;
      closed++;
    }
    return closed;
  }

  async runFinalAudit(): Promise<{
    passed: boolean;
    done: number;
    total: number;
    pendingSteps: string[];
    missingFiles: string[];
    summary: string;
  } | null> {
    // No active tracker: audit the last completed plan instead of bailing.
    // A plan finished via `plan update` auto-archives and clears the tracker;
    // without this the final audit (tests + tsc + file checks) was silently
    // skipped and the model could declare success on broken artifacts.
    if (!this.tracker) {
      if (!this.completedPlan) return null;
      const plan = this.completedPlan;
      const autoClosed = this.autoCloseEvidenceSteps(plan);
      const audit = await this.auditor.audit(plan);
      const pendingSteps = plan.steps.flatMap((s) =>
        s.status !== "done" && s.status !== "skipped" ? [`${s.id}. ${s.description}`] : [],
      );
      const done = plan.steps.filter((s) => s.status === "done").length;
      if (autoClosed > 0) {
        this.store.saveActive(plan);
      }
      return {
        passed: audit.passed && pendingSteps.length === 0,
        done,
        total: plan.steps.length,
        pendingSteps,
        missingFiles: audit.missingFiles,
        summary: audit.summary,
      };
    }
    if (this._auditSkipsRemaining > 0) {
      this._auditSkipsRemaining--;
      return null;
    }
    const plan = this.tracker.getPlan();
    const autoClosed = this.autoCloseEvidenceSteps(plan);
    if (autoClosed > 0) {
      this.store.saveActive(plan);
    }
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
      recordCompleted: (p) => this.recordCompleted(p),
      clearCompleted: () => this.clearCompleted(),
      hasStepDeliverables: (s) => this.hasStepDeliverables(s),
      missingStepDeliverables: (s) => this.missingStepDeliverables(s),
      stillExistingDeliverables: (s) => this.stillExistingDeliverables(s),
      parseKinds: (a, st) => this.parseKinds(a, st),
      getTaskText: (c) => this.getTaskText(c),
      typecheckFailures: this.state.typecheckFailures,
      baseDir: this.baseDir,
      wasFileDeleted: this.hallucinationDetector
        ? (path: string) =>
            this.hallucinationDetector!.getConsistencyCheck().getDeletedFiles().includes(path)
        : undefined,
    });
  }

  getPlugin(): AgentPlugin {
    return createExecutionPlugin({
      stuckDetector: this.stuckDetector,
      trackerRef: this.trackerRef,
      pendingMessages: this.pendingMessages,
      forbiddenBashFailures: this.forbiddenBashFailures,
      state: this.state,
      store: this.store,
      checkPlanAlignment: (call) => this.checkPlanAlignment(call),
      advancePlanIfStepComplete: (cm, sl) => this.advancePlanIfStepComplete(cm, sl),
      maybeSearchError: (ctx, call) => this.maybeSearchError(ctx, call),
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

    if (PLAN_ALIGNMENT_EXEMPT_TOOLS.has(call.name)) return null;

    const stepPaths = extractFileLikeTokens(stripUrls(step.description)).map((p) =>
      p.toLowerCase(),
    );
    if (stepPaths.length === 0) return null;

    // Only path-ish arguments are inspected. JSON-stringifying the whole args
    // blob made write_file/edit_file `content` feed its code tokens into the
    // off-path check (e.g. `import "./styles.css"` inside the file body) and
    // raised phantom alignment warnings for on-track writes.
    const argStr = this.pathArgStrings(call.arguments).join(" ");
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

    // Bidirectional path-token overlap, used for BOTH checks below. A step may
    // name "main.ts" while the tool calls "src/main.ts" (or vice versa), so a
    // one-directional `s.includes(p)` missed the common nested/partial case
    // (observed: rewriting a completed step's src/main.ts was flagged as
    // off-path for the current step and helped hard-block the third call).
    const matchesAny = (p: string, tokens: string[]) =>
      tokens.some((t) => t === p || t.includes(p) || p.includes(t));
    const finished = [...finishedPaths];

    const offPath = callPaths.some((p) => {
      if (matchesAny(p, finished)) return false;
      return !matchesAny(p, stepPaths);
    });
    if (!offPath) return null;

    return t("exec.plan_warning", {
      step: String(step.id),
      description: step.description,
      tool: call.name,
    });
  }

  /** String values of the path-like arguments of a tool call. Limits the
   *  off-path alignment check to arguments that actually name files (path,
   *  file, dir, src, dst, source, target, input, output, destination, glob,
   *  workdir, cwd, command, pattern) and never scans payload content. */
  private pathArgStrings(args: Record<string, unknown> | undefined): string[] {
    if (!args) return [];
    const out: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (
        !/path|file|dir|src|dst|source|target|input|output|destination|glob|workdir|cwd|command|pattern|query/i.test(
          key,
        )
      ) {
        continue;
      }
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) {
        for (const v of value) if (typeof v === "string") out.push(v);
      }
    }
    return out;
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

    // Step gate: verify dependencies when mentioned — check BEFORE file paths.
    // Requires an actual package-manager verb (rule #10 — no bare keyword
    // matching: "init" alone or "setup project" must NOT trigger the lockfile
    // hint, only concrete dependency-install commands do).
    const isDepsStep =
      /(?:npm|bun|yarn|pnpm|pip|pip3|pipenv|poetry|composer|deno|go|gem|cargo)\s+(?:install|add|init|i|get)\b|bun\s+(?:add|install)|npm\s+(?:i|install|add)|(?:install|установ\w*)\s+(?:dependencies|зависимост\w*|пакет\w*|packages?)/i.test(
        stepText,
      );
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

    // Resolve tokens with the SAME subtree walk the deliverable gate and the
    // auditor use (findExistingFile), so a nested file
    // ("bicycle-shop/src/bicycles.ts" for token "src/bicycles.ts") counts as
    // present. The old exact existsSync(resolve()) never matched nested
    // projects, so auto-advance stayed silent even after the model wrote the
    // real file.
    const resolved = stepPaths.map((p) => findExistingFile(this.baseDir, p));
    const allExist = resolved.every((r) => r !== null);
    const allGone = resolved.every((r) => r === null);
    const satisfied = step.kind === "delete" ? allGone && !allExist : allExist;
    if (!satisfied) return;

    // Step gate: verify files have content (not empty)
    if (step.kind !== "delete") {
      const emptyFiles: string[] = [];
      for (const r of resolved) {
        if (!r) continue;
        try {
          const content = readFileSync(r, "utf-8");
          if (content.trim().length < 10) {
            emptyFiles.push(r);
          }
        } catch {
          // If we can't read it, rely on the existence result
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
      this.recordCompleted(completed); // final audit still verifies it
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

  /** Whether a step description names at least one real file token. Steps
   *  with no file tokens (pure commands, verification runs) cannot be
   *  auto-verified — the done-gate is vacuous for them. */
  private hasStepDeliverables(step: { description: string }): boolean {
    return extractFileLikeTokens(stripUrls(step.description)).length > 0;
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
