import { t } from "../../i18n/index";
import { isTransientError } from "./transient-error";

interface ToolCallRecord {
  name: string;
  argsKey: string;
}

export type ErrorClassification = "transient" | "systematic" | "blocking";

/**
 * Stable, machine-readable failure taxonomy for stuck/recovery diagnostics.
 *
 * Mapped from the detector's live states (see `classifyFailure`). The original
 * plan also named `scope_drift` and `empty_output`; neither has a reliable
 * detector signal here (scope drift is not tracked, empty output is covered by
 * `getActionableHints`), so they are intentionally not invented.
 */
export type FailureType =
  | "timeout" // no progress across N iterations on the current step
  | "repeat" // identical tool call (same args) repeated
  | "error_loop" // one tool, or consecutive calls, failing repeatedly
  | "bash_flailing" // rotating failing shell commands
  | "read_only"; // long read-only exploration loop with no writes

export interface FailureClassification {
  type: FailureType;
  /** Tool the failure is attributable to, when known. */
  tool?: string;
  /** Repetition/failure count, when meaningful. */
  count?: number;
  /** Agent-loop iteration at classification time (0 when unknown). */
  iteration: number;
}

const BLOCKING_PATTERNS = [
  /EACCES/i,
  /permission denied/i,
  /EPERM/i,
  /ENOENT.*node_modules/i,
  /ENOTDIR/i,
  /invalid.*token/i,
  /unauthorized/i,
  /401/i,
  /403/i,
];

export function classifyError(output: string): ErrorClassification {
  if (isTransientError(output)) return "transient";
  for (const p of BLOCKING_PATTERNS) {
    if (p.test(output)) return "blocking";
  }
  return "systematic";
}

/**
 * Tools that only observe state and never change it. A long run of only these
 * with no write/exec in between means the model is reading/exploring without
 * producing anything — a read-only loop that the stuck detector must surface
 * (observed: 50+ read_file iterations with zero writes after a false-positive
 * audit rejected a completed task).
 */
const READ_ONLY_TOOLS = new Set([
  "read_file",
  "glob",
  "grep",
  "list_dir",
  "file_info",
  "browser",
  "web_search",
  "web_fetch",
  "web_browse",
  "search_history",
  "recall",
  "project_map",
  "chunk_query",
  "process_list",
  "process_log",
  "plan",
  "todo",
  "verify",
  "load_skill",
]);

/** Consecutive read-only tool calls that constitute a loop. */
const READ_ONLY_LOOP_THRESHOLD = 10;

/**
 * Bash flailing: ≥BASH_FLAIL_THRESHOLD failures within the last
 * BASH_FLAIL_WINDOW bash attempts, regardless of interleaved successes.
 * The per-word hard-stop (bash.ts) is evaded by rotating commands
 * (wc → cat → Get-Content → …); this window catches the rotation itself
 * (observed in ses_mt4x3zbo: 8 failed shell tricks across ~12 iterations
 * trying to count/merge files on Windows).
 */
const BASH_FLAIL_WINDOW = 6;
const BASH_FLAIL_THRESHOLD = 4;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** Пути (абсолютные/относительные) + опционально :line:col. */
const ERROR_LOC_RE =
  /(?:[A-Za-z]:[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]+\.[a-zA-Z0-9]{1,6}(?::\d+(?::\d+)?)?/g;
const SIGNATURE_MAX_CHARS = 120;

const SEARCHABLE_PATTERNS: RegExp[] = [
  /error TS\d+/i,
  /ERR_[A-Z_]+/,
  /ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EADDRINUSE/i,
  /Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i,
  /TypeError|ReferenceError|SyntaxError|RangeError/i,
  /is not a function|is not defined|is not a constructor/i,
  /Cannot read properties of/i,
  /failed to (compile|build|resolve|parse)/i,
  /fatal error|panic/i,
];

const RUNTIME_WORDS = [
  "bun",
  "node",
  "deno",
  "npm",
  "yarn",
  "pnpm",
  "pip",
  "pip3",
  "python",
  "python3",
  "tsc",
  "tsx",
  "npx",
  "go",
  "cargo",
  "gradle",
  "maven",
  "make",
];
const FRAMEWORK_WORDS = [
  "react",
  "vue",
  "angular",
  "svelte",
  "vite",
  "next",
  "nest",
  "express",
  "fastify",
  "flask",
  "django",
  "spring",
  "webpack",
  "tailwind",
];

/**
 * Stable identity for an error: tool + normalized first error lines (ANSI
 * stripped, paths/locations replaced, whitespace collapsed, capped at 120
 * chars). Two runs failing with the same root cause produce the same
 * signature — that is what triggers the automatic web search.
 */
export function normalizeErrorSignature(toolName: string, output?: string): string | null {
  if (!output) return null;
  const cleaned = output
    .replace(ANSI_RE, "")
    .replace(ERROR_LOC_RE, " <path>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return `${toolName}::${cleaned.slice(0, SIGNATURE_MAX_CHARS)}`;
}

/**
 * Gate for the automatic web search: only real, meaningful error text is
 * worth searching for. "Command failed with exit code 1" without details is
 * noise — searching it would just burn a query.
 */
export function isSearchableError(output: string): boolean {
  if (!output?.trim()) return false;
  const text = output.trim();
  return SEARCHABLE_PATTERNS.some((p) => p.test(text));
}

/**
 * Build the search query for a failing error: up to 3 cleaned error lines
 * (paths stripped), prefixed with the runtime and framework detected from the
 * step/bash context, suffixed with "how to fix". Falls back to `tool step`
 * when the error text is empty. Capped at maxQueryChars.
 */
export function buildSearchQuery(
  stepDescription: string,
  lastBashCommand: string,
  lastErrorOutput: string,
  toolName: string,
  maxQueryChars: number,
): string {
  const errorText = (lastErrorOutput || "")
    .replace(ANSI_RE, "")
    .replace(ERROR_LOC_RE, " <path>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const context = `${stepDescription} ${lastBashCommand}`.toLowerCase();
  const runtime = RUNTIME_WORDS.find((w) => context.includes(w)) || "";
  const framework = FRAMEWORK_WORDS.find((w) => context.includes(w)) || "";
  let query: string;
  if (errorText) {
    query =
      runtime && !errorText.toLowerCase().includes(runtime) ? `${runtime} ${errorText}` : errorText;
    if (framework && !query.toLowerCase().includes(framework)) query = `${query} ${framework}`;
    query = `${query} how to fix`;
  } else if (runtime || framework) {
    query = `${[runtime, framework, "error", "how to fix"].filter(Boolean).join(" ")}`;
  } else {
    query = `${toolName} ${stepDescription} how to fix`;
  }
  return query.slice(0, maxQueryChars);
}

export class StuckDetector {
  private threshold: number;
  private errorThreshold: number;
  private iterationsOnCurrentStep = 0;
  private currentStepId: number | null = null;
  private toolErrors: Map<string, number> = new Map();
  private currentStepDescription = "";
  private recentToolCalls: ToolCallRecord[] = [];
  private readonly maxRecentCalls = 10;
  private readonly repetitionThreshold = 3;
  private consecutiveFailures = 0;
  private lastFailedTool = "";
  private lastErrorOutput = "";
  private escalationCount = 0;
  private readonly escalationThreshold = 3;
  private fileRewriteCount: Map<string, number> = new Map();
  private readonly fileRewriteThreshold = 3;
  private lastBashCommand = "";
  private lastBashOutput = "";
  private emptyBashRunCount = 0;
  private readOnlyStreak = 0;
  private bashRecent: boolean[] = [];
  private errorSignatureCounts: Map<string, number> = new Map();
  private searchedErrorSignatures: Set<string> = new Set();
  private webSearchThreshold: number;

  constructor(threshold = 6, errorThreshold = 3, webSearchThreshold = 5) {
    this.threshold = threshold;
    this.errorThreshold = errorThreshold;
    this.webSearchThreshold = webSearchThreshold;
  }

  recordIteration(stepId: number): void {
    if (stepId === this.currentStepId) {
      this.iterationsOnCurrentStep++;
    } else {
      this.resetStepState(stepId);
    }
  }

  recordToolCall(name: string, args: Record<string, unknown>): void {
    const argsKey = JSON.stringify(args);
    this.recentToolCalls.push({ name, argsKey });
    if (this.recentToolCalls.length > this.maxRecentCalls) {
      this.recentToolCalls.shift();
    }
    // Track the consecutive read-only streak. A write/exec tool resets it;
    // plan/todo bookkeeping counts as read-only (it is not real progress).
    if (READ_ONLY_TOOLS.has(name)) {
      this.readOnlyStreak++;
    } else {
      this.readOnlyStreak = 0;
    }
  }

  /**
   * True after a long run of read-only tool calls with no write in between.
   * The model is exploring/looping without producing anything — inject a
   * recovery hint so it stops re-reading and actually edits files.
   */
  hasReadOnlyLoop(): boolean {
    return this.readOnlyStreak >= READ_ONLY_LOOP_THRESHOLD;
  }

  recordToolError(toolName: string, output?: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1);
    this.consecutiveFailures++;
    this.lastFailedTool = toolName;
    if (output) this.lastErrorOutput = output;
    const sig = normalizeErrorSignature(toolName, output);
    if (sig) {
      this.errorSignatureCounts.set(sig, (this.errorSignatureCounts.get(sig) || 0) + 1);
    }
  }

  getLastErrorOutput(): string {
    return this.lastErrorOutput;
  }

  /**
   * Record every bash invocation (successful or not) so stuck detection can
   * reason about repeated runs with empty output, entry-point issues, and
   * platform mistakes (PowerShell cmdlets in cmd.exe, bash heredocs, ...).
   */
  recordBashOutput(command: string, output: string): void {
    const trimmed = output.trim();
    if (command === this.lastBashCommand && !trimmed) {
      this.emptyBashRunCount++;
    } else {
      this.emptyBashRunCount = 0;
    }
    this.lastBashCommand = command;
    this.lastBashOutput = output;
  }

  /** Outcome of one bash attempt (success or failure), for flailing detection. */
  recordBashAttempt(success: boolean): void {
    this.bashRecent.push(success);
    if (this.bashRecent.length > BASH_FLAIL_WINDOW) this.bashRecent.shift();
  }

  /** True when most recent bash attempts failed — the model is flailing. */
  hasBashFlailing(): boolean {
    if (this.bashRecent.length < BASH_FLAIL_THRESHOLD) return false;
    let failures = 0;
    for (const ok of this.bashRecent) if (!ok) failures++;
    return failures >= BASH_FLAIL_THRESHOLD;
  }

  getLastBashCommand(): string {
    return this.lastBashCommand;
  }

  getLastBashOutput(): string {
    return this.lastBashOutput;
  }

  getLastFailedTool(): string {
    return this.lastFailedTool;
  }

  /**
   * First error signature whose repetition count reached the web-search
   * threshold and that has NOT been searched yet (or was unmarked for a
   * retry). This is what triggers the automatic web search — not iterations
   * and not the per-tool error count.
   */
  getRepeatedErrorSignature(): string | null {
    for (const [sig, count] of this.errorSignatureCounts) {
      if (count >= this.webSearchThreshold && !this.searchedErrorSignatures.has(sig)) {
        return sig;
      }
    }
    return null;
  }

  getErrorSignatureCount(sig: string): number {
    return this.errorSignatureCounts.get(sig) || 0;
  }

  markErrorSearched(sig: string): void {
    this.searchedErrorSignatures.add(sig);
  }

  unmarkErrorSearched(sig: string): void {
    this.searchedErrorSignatures.delete(sig);
  }

  hasErrorSearched(sig: string): boolean {
    return this.searchedErrorSignatures.has(sig);
  }

  getIterationsOnCurrentStep(): number {
    return this.iterationsOnCurrentStep;
  }

  recordToolSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastFailedTool = "";
    // NOTE: escalationCount is deliberately NOT reset here. A single trivial
    // tool success (e.g. one read_file) used to clear it, so shouldEscalate()
    // was rarely reached on a flailing session — defeating the anti-gaming
    // property that resetStepState() explicitly preserves.
    // Decay per-tool error counters on productive calls: a tool that failed
    // early must not keep the "Tool X failed N times" warning alive forever
    // (ses_mt4fn58c — bash failed 3x, warning re-logged after 30 successful
    // writes). Fresh failures rebuild the count.
    for (const [tool, count] of this.toolErrors) {
      if (count <= 1) this.toolErrors.delete(tool);
      else this.toolErrors.set(tool, count - 1);
    }
    // Decay iteration counter on productive tool calls — reading new files,
    // writing, editing all count as progress. Prevents false-positive stuck
    // warnings during legitimate file exploration (e.g. reading 12 files in
    // an analysis step).
    if (this.iterationsOnCurrentStep > 0) {
      this.iterationsOnCurrentStep = Math.max(0, this.iterationsOnCurrentStep - 1);
    }
  }

  setCurrentStep(stepId: number, description: string): void {
    if (stepId !== this.currentStepId) {
      this.resetStepState(stepId);
    }
    this.currentStepDescription = description;
  }

  isStuck(): boolean {
    return this.iterationsOnCurrentStep > this.threshold;
  }

  hasRepetitiveErrors(toolName?: string): boolean {
    if (toolName) {
      return (this.toolErrors.get(toolName) || 0) >= this.errorThreshold;
    }
    return Array.from(this.toolErrors.values()).some((c) => c >= this.errorThreshold);
  }

  hasRepetitiveToolCalls(): boolean {
    if (this.recentToolCalls.length < this.repetitionThreshold) return false;
    const last = this.recentToolCalls[this.recentToolCalls.length - 1];
    // Check consecutive identical calls (original logic)
    let consecutiveCount = 1;
    for (let i = this.recentToolCalls.length - 2; i >= 0; i--) {
      if (
        this.recentToolCalls[i].name === last.name &&
        this.recentToolCalls[i].argsKey === last.argsKey
      ) {
        consecutiveCount++;
      } else {
        break;
      }
    }
    if (consecutiveCount >= this.repetitionThreshold) return true;
    // Also detect interleaved patterns (A, B, A, B, A) — count any single
    // tool+args combo in the window and flag if it appears >= threshold times
    const counts = new Map<string, number>();
    for (const call of this.recentToolCalls) {
      const key = `${call.name}::${call.argsKey}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= this.repetitionThreshold) return true;
    }
    return false;
  }

  hasConsecutiveFailures(): boolean {
    return this.consecutiveFailures >= this.errorThreshold;
  }

  getConsecutiveFailuresCount(): number {
    return this.consecutiveFailures;
  }

  recordEscalation(): void {
    this.escalationCount++;
  }

  shouldEscalate(): boolean {
    return this.escalationCount >= this.escalationThreshold;
  }

  resetEscalation(): void {
    this.escalationCount = 0;
  }

  getEscalationCount(): number {
    return this.escalationCount;
  }

  getHints(): string[] {
    const hints: string[] = [];
    const desc = this.currentStepDescription.toLowerCase();

    if (desc.includes("install") || desc.includes("npm") || desc.includes("pip")) {
      hints.push(t("exec.hint_deps"));
    }
    if (desc.includes("test") || desc.includes("spec")) {
      hints.push(t("exec.hint_test"));
    }
    if (desc.includes("build") || desc.includes("compile")) {
      hints.push(t("exec.hint_build"));
    }
    if (desc.includes("deploy") || desc.includes("publish")) {
      hints.push(t("exec.hint_deploy"));
    }

    // State-based bullets. The recovery message (getRecoveryMessage) already
    // reports the PRIMARY reason (priority: stuck > tool-errors > consecutive
    // > repetitive > read-only). Repeating that same state here as a hint
    // would duplicate the guidance in the same cooldown block. Only add the
    // bullet when the recovery message is NOT already covering that state.
    const primary = this.getPrimaryReason();
    if (this.hasRepetitiveToolCalls() && primary !== "repetitive") {
      hints.push(t("exec.hint_repetitive"));
    }
    if (this.hasConsecutiveFailures() && primary !== "consecutive") {
      hints.push(t("exec.hint_consecutive"));
    }
    if (this.hasReadOnlyLoop() && primary !== "read-only") {
      hints.push(t("exec.hint_read_only"));
    }
    return hints;
  }

  getActionableHints(): string[] {
    const hints: string[] = [];
    const error = this.lastErrorOutput;

    // Bash-specific hints do not depend on a tool failure — they fire even
    // when the command "succeeded" with empty output (missing entry point).
    const isScriptRun =
      /(^|[\s&])(bun|node|tsx|ts-node|deno|python|python3)\S*\s+[^|&]+\s+[^\s]+$/.test(
        this.lastBashCommand,
      );
    if (isScriptRun && !this.lastBashOutput.trim() && this.emptyBashRunCount >= 2) {
      hints.push(
        `The command "${this.lastBashCommand}" ran ${this.emptyBashRunCount} times with EMPTY output. The program likely has no entry point — read the file with read_file and check that it actually calls its main function with process.argv / CLI arguments and prints results (console.log). Then run it again.`,
      );
    }

    if (!error) return hints;

    // Runtime incompatibility — tool/module crashes on this Node version
    if (/Cannot read properties of undefined|is not a function|is not a constructor/i.test(error)) {
      if (/node_modules/.test(error)) {
        hints.push(
          "A dependency is incompatible with your Node.js version. Check if there is an alternative package or use a different runtime.",
        );
      }
    }

    // TypeScript syntax errors — model generated invalid code
    if (/TS1005|TS1003|TS1109|TS1128|TS1434/i.test(error)) {
      hints.push(
        "TypeScript syntax error. Read the error message carefully — it tells you the exact line and column. Fix the syntax before retrying.",
      );
    }

    // TypeScript type errors — model doesn't understand the types
    if (/TS2322|TS2345|TS2769|TS7006|TS7016/i.test(error)) {
      hints.push(
        "TypeScript type mismatch. Check the type signature of the function/API you are using. If a package lacks type declarations, install @types/<package> or use skipLibCheck.",
      );
    }

    // Module not found — missing dependency or wrong import
    if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i.test(error)) {
      hints.push("Module not found. Run npm install or check if the import path is correct.");
    }

    // Permission / access errors
    if (/EACCES|EPERM|permission denied/i.test(error)) {
      hints.push("Permission denied. Check file permissions or run with appropriate privileges.");
    }

    // Network errors
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(error)) {
      hints.push("Network error. Check if the server is running and accessible.");
    }

    // Command not found
    if (/is not recognized|command not found|not found in path/i.test(error)) {
      hints.push("Command not found. Check if the tool is installed and in PATH.");
    }

    // File rewrite loop — same file keeps failing
    if (this.hasExcessiveRewrites()) {
      const file = this.getExcessiveRewriteFile();
      hints.push(
        `File ${file} has been rewritten ${this.getFileRewriteCount(file!)} times without success. Stop rewriting and try a fundamentally different approach.`,
      );
    }

    // Repeated identical bash runs with empty output — likely a missing
    // entry point (the program never calls its main function).

    // PowerShell cmdlets used inside cmd.exe (Windows shell mismatch).
    if (/Write-Host|Get-Content|Select-String|Out-File|Set-Content/i.test(error)) {
      hints.push(
        "That looks like a PowerShell cmdlet — the shell here is cmd.exe. Use echo/type for output or the read_file/write_file tools instead.",
      );
    }

    // Model invented a Bun API that does not exist.
    if (
      /Bun\.\w+ is not a function|Bun\.\w+ is not defined|Bun\.\w+ is not a constructor/i.test(
        error,
      )
    ) {
      hints.push(
        "That Bun API does not exist. Verify the API name in the Bun docs — common ones are Bun.file, Bun.write, Bun.spawn, Bun.serve. For file checks use fs.existsSync from node:fs.",
      );
    }

    // The model keeps writing a file whose output shows a type/syntax
    // error — read the actual error and fix it, don't rewrite blindly.
    if (/error TS\d+|typecheck failed|syntax check failed/i.test(error)) {
      hints.push(
        "The file still has a type/syntax error (see the error line in the output). Read the file with read_file around the reported line, fix the actual error, then re-run — rewriting the whole file blindly usually makes it worse.",
      );
    }

    // Bash heredoc in cmd.exe.
    if (/unexpected.*<<|Непредвиденное появление/i.test(error)) {
      hints.push(
        "Heredoc (<< EOF) is a bash feature — this shell is cmd.exe and does not support it. Write the file with write_file instead.",
      );
    }

    return hints;
  }

  getToolAlternative(): string | null {
    const tool = this.lastFailedTool;
    const error = this.lastErrorOutput;

    if (!tool) return null;

    // If a tool fails with a runtime crash, suggest alternatives
    if (
      /Cannot read properties of undefined|is not a function|TypeError|ReferenceError/i.test(error)
    ) {
      // Map of tools to their common alternatives
      const alternatives: Record<string, string> = {
        "ts-node": "tsx",
        jest: "vitest",
        mocha: "vitest",
        webpack: "vite",
        rollup: "vite",
        parcel: "vite",
        babel: "tsc",
        eslint: "biome",
        prettier: "biome",
      };

      for (const [failed, alt] of Object.entries(alternatives)) {
        if (tool.includes(failed) || error.includes(failed)) {
          return alt;
        }
      }
    }

    return null;
  }

  recordFileRewrite(filePath: string): void {
    const count = (this.fileRewriteCount.get(filePath) || 0) + 1;
    this.fileRewriteCount.set(filePath, count);
  }

  getFileRewriteCount(filePath: string): number {
    return this.fileRewriteCount.get(filePath) || 0;
  }

  hasExcessiveRewrites(): boolean {
    return Array.from(this.fileRewriteCount.values()).some((c) => c >= this.fileRewriteThreshold);
  }

  getExcessiveRewriteFile(): string | null {
    for (const [file, count] of this.fileRewriteCount) {
      if (count >= this.fileRewriteThreshold) return file;
    }
    return null;
  }

  getRepetitiveToolMessage(): string {
    if (!this.hasRepetitiveToolCalls()) return "";
    const last = this.recentToolCalls[this.recentToolCalls.length - 1];
    const base = t("exec.repetitive_tool", {
      tool: last.name,
      count: this.repetitionThreshold,
    });
    // Polling a background process one check at a time burns an LLM call per
    // poll — point at the single blocking wait instead.
    if (last.name === "process_log") {
      return `${base} ${t("exec.repetitive_process_log_hint")}`;
    }
    return base;
  }

  /**
   * Stable warning identity for anti-spam dedup: the same key re-logged every
   * iteration is spam, a NEW key (or a long gap) deserves a re-warn.
   */
  getWarningKey(): string {
    if (this.isStuck()) return "stuck";
    const errorTool = Array.from(this.toolErrors.entries()).find(
      ([_, c]) => c >= this.errorThreshold,
    );
    if (errorTool) return `tool-errors:${errorTool[0]}`;
    if (this.hasBashFlailing()) return "bash-flailing";
    if (this.hasConsecutiveFailures()) return "consecutive";
    if (this.hasRepetitiveToolCalls()) return "repetitive";
    if (this.hasReadOnlyLoop()) return "read-only";
    return "";
  }

  getStuckReason(): string {
    if (this.isStuck()) {
      return t("exec.stuck", {
        stepId: String(this.currentStepId ?? "?"),
        description: this.currentStepDescription,
        iterations: this.iterationsOnCurrentStep,
      });
    }
    const errorTool = Array.from(this.toolErrors.entries()).find(
      ([_, c]) => c >= this.errorThreshold,
    );
    if (errorTool) {
      return t("exec.tool_errors", { tool: errorTool[0], count: errorTool[1] });
    }
    if (this.hasBashFlailing()) {
      const fails = this.bashRecent.filter((ok) => !ok).length;
      return t("exec.bash_flailing", {
        fails: String(fails),
        window: String(this.bashRecent.length),
      });
    }
    if (this.hasConsecutiveFailures()) {
      return t("exec.consecutive_failures", { count: String(this.consecutiveFailures) });
    }
    // Repetitive identical calls are a loop even when nothing fails (e.g. a
    // process_log poll cycle) — without this branch they stayed invisible:
    // getWarningKey reported "repetitive" but no reason was ever logged.
    if (this.hasRepetitiveToolCalls()) {
      return this.getRepetitiveToolMessage();
    }
    if (this.hasReadOnlyLoop()) {
      return t("exec.read_only_loop", {
        count: String(this.readOnlyStreak),
      });
    }
    return "";
  }

  getRecoveryMessage(): string {
    const reason = this.getPrimaryReason();
    if (reason === "stuck") {
      return t("exec.stuck_recovery", {
        iterations: this.iterationsOnCurrentStep,
        stepId: String(this.currentStepId ?? "?"),
        description: this.currentStepDescription,
      });
    }
    // Per-tool error recovery (more specific — e.g., "bash failed 3 times")
    if (reason === "tool-errors") {
      const errorTool = Array.from(this.toolErrors.entries()).find(
        ([_, c]) => c >= this.errorThreshold,
      )!;
      return t("exec.tool_errors_recovery", {
        tool: errorTool[0],
        count: errorTool[1],
      });
    }
    // Consecutive failures from different tools (generic — e.g., "5 consecutive failures")
    if (reason === "consecutive") {
      return t("exec.consecutive_failures_recovery", {
        count: this.consecutiveFailures,
      });
    }
    if (reason === "bash-flailing") {
      const fails = this.bashRecent.filter((ok) => !ok).length;
      return t("exec.bash_flailing_recovery", {
        fails: String(fails),
        window: String(this.bashRecent.length),
      });
    }
    if (reason === "repetitive") {
      return this.getRepetitiveToolMessage();
    }
    if (reason === "read-only") {
      return t("exec.read_only_loop_recovery", {
        count: String(this.readOnlyStreak),
      });
    }
    return "";
  }

  /**
   * Classify the current failure state into a stable {@link FailureType} for
   * diagnostics/logs. Returns null when healthy. `iteration` is supplied by the
   * caller (the detector does not track the global loop counter).
   */
  classifyFailure(iteration = 0): FailureClassification | null {
    const primary = this.getPrimaryReason();
    if (!primary) return null;
    switch (primary) {
      case "stuck":
        return { type: "timeout", iteration };
      case "tool-errors": {
        const entry = Array.from(this.toolErrors.entries()).find(
          ([, c]) => c >= this.errorThreshold,
        );
        return { type: "error_loop", tool: entry?.[0], count: entry?.[1], iteration };
      }
      case "consecutive":
        return { type: "error_loop", count: this.consecutiveFailures, iteration };
      case "repetitive": {
        const last = this.recentToolCalls[this.recentToolCalls.length - 1];
        return { type: "repeat", tool: last?.name, count: this.repetitionThreshold, iteration };
      }
      case "bash-flailing": {
        const fails = this.bashRecent.filter((ok) => !ok).length;
        return { type: "bash_flailing", count: fails, iteration };
      }
      case "read-only":
        return { type: "read_only", count: this.readOnlyStreak, iteration };
    }
  }

  /** Compact `[STUCK: type=..., tool=..., count=..., iteration=N]` marker. */
  formatFailureDiagnostic(c: FailureClassification): string {
    const parts = [`type=${c.type}`];
    if (c.tool) parts.push(`tool=${c.tool}`);
    if (typeof c.count === "number") parts.push(`count=${c.count}`);
    if (c.iteration > 0) parts.push(`iteration=${c.iteration}`);
    return `[STUCK: ${parts.join(", ")}]`;
  }

  /** Diagnostic marker for the current state, or "" when healthy. */
  getStuckDiagnostic(iteration = 0): string {
    const c = this.classifyFailure(iteration);
    return c ? this.formatFailureDiagnostic(c) : "";
  }

  /**
   * Single source of truth for the recovery reason priority. Used by BOTH
   * getRecoveryMessage() and getHints() so the two cannot drift apart: the
   * state bullet that getRecoveryMessage already reports is NOT repeated as a
   * hint (priority: stuck > tool-errors > consecutive > repetitive >
   * read-only).
   */
  private getPrimaryReason():
    | "stuck"
    | "tool-errors"
    | "consecutive"
    | "repetitive"
    | "read-only"
    | "bash-flailing"
    | null {
    if (this.isStuck()) return "stuck";
    const errorTool = Array.from(this.toolErrors.entries()).find(
      ([_, c]) => c >= this.errorThreshold,
    );
    if (errorTool) return "tool-errors";
    if (this.hasBashFlailing()) return "bash-flailing";
    if (this.hasConsecutiveFailures()) return "consecutive";
    if (this.hasRepetitiveToolCalls()) return "repetitive";
    if (this.hasReadOnlyLoop()) return "read-only";
    return null;
  }

  reset(): void {
    this.currentStepId = null;
    this.iterationsOnCurrentStep = 0;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.recentToolCalls = [];
    this.fileRewriteCount.clear();
    this.escalationCount = 0;
    this.lastBashCommand = "";
    this.lastBashOutput = "";
    this.emptyBashRunCount = 0;
    this.bashRecent = [];
    this.readOnlyStreak = 0;
    this.errorSignatureCounts.clear();
    this.searchedErrorSignatures.clear();
  }

  /**
   * Reset only step-progress state, keeping the tool-call history and the
   * read-only streak. Used when the plan is complete but the loop continues
   * (e.g. the audit gate rejected a finished task): step-stuck warnings are
   * silenced, but a read-without-write loop is still detected.
   */
  resetStepProgress(): void {
    this.currentStepId = null;
    this.iterationsOnCurrentStep = 0;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.fileRewriteCount.clear();
    this.escalationCount = 0;
    this.lastBashCommand = "";
    this.lastBashOutput = "";
    this.emptyBashRunCount = 0;
    this.bashRecent = [];
    this.errorSignatureCounts.clear();
    this.searchedErrorSignatures.clear();
  }

  /**
   * Reset all per-step state when moving to a new step. Prevents errors and
   * tool repetitions from one step leaking into the next (false-positive
   * stuck/recovery on the first iteration of the new step).
   */
  private resetStepState(stepId: number): void {
    this.currentStepId = stepId;
    this.iterationsOnCurrentStep = 1;
    this.toolErrors.clear();
    this.consecutiveFailures = 0;
    this.lastFailedTool = "";
    this.lastErrorOutput = "";
    this.recentToolCalls = [];
    this.fileRewriteCount.clear();
    this.lastBashCommand = "";
    this.lastBashOutput = "";
    this.emptyBashRunCount = 0;
    this.bashRecent = [];
    this.readOnlyStreak = 0;
    this.errorSignatureCounts.clear();
    this.searchedErrorSignatures.clear();
    // Preserve escalationCount — prevents agent from "gaming" stuck detection
    // by marking a step done and moving to the next one
  }
}
