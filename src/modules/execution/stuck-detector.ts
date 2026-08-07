import { t } from "../../i18n/index";

interface ToolCallRecord {
  name: string;
  argsKey: string;
}

export type ErrorClassification = 'transient' | 'systematic' | 'blocking'

const TRANSIENT_PATTERNS = [
  /timeout/i, /timed out/i, /ECONNREFUSED/i, /ETIMEDOUT/i,
  /ECONNRESET/i, /killed/i, /SIGTERM/i, /SIGKILL/i,
  /rate limit/i, /429/i, /503/i, /502/i,
]

const BLOCKING_PATTERNS = [
  /EACCES/i, /permission denied/i, /EPERM/i,
  /ENOENT.*node_modules/i, /ENOTDIR/i,
  /invalid.*token/i, /unauthorized/i, /401/i, /403/i,
]

export function classifyError(output: string): ErrorClassification {
  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(output)) return 'transient'
  }
  for (const p of BLOCKING_PATTERNS) {
    if (p.test(output)) return 'blocking'
  }
  return 'systematic'
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
  private fileRewriteCount: Map<string, number> = new Map()
  private readonly fileRewriteThreshold = 3

  constructor(threshold = 8, errorThreshold = 3) {
    this.threshold = threshold;
    this.errorThreshold = errorThreshold;
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
  }

  recordToolError(toolName: string, output?: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1);
    this.consecutiveFailures++;
    this.lastFailedTool = toolName;
    if (output) this.lastErrorOutput = output;
  }

  getLastErrorOutput(): string {
    return this.lastErrorOutput
  }

  getLastFailedTool(): string {
    return this.lastFailedTool
  }

  getIterationsOnCurrentStep(): number {
    return this.iterationsOnCurrentStep
  }

  recordToolSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastFailedTool = "";
    this.escalationCount = 0;
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
    return Array.from(this.toolErrors.values()).some(
      (c) => c >= this.errorThreshold,
    );
  }

  hasRepetitiveToolCalls(): boolean {
    if (this.recentToolCalls.length < this.repetitionThreshold) return false;
    const last = this.recentToolCalls[this.recentToolCalls.length - 1];
    let count = 1;
    for (let i = this.recentToolCalls.length - 2; i >= 0; i--) {
      if (
        this.recentToolCalls[i].name === last.name &&
        this.recentToolCalls[i].argsKey === last.argsKey
      ) {
        count++;
      } else {
        break;
      }
    }
    return count >= this.repetitionThreshold;
  }

  hasConsecutiveFailures(): boolean {
    return this.consecutiveFailures >= this.errorThreshold;
  }

  getConsecutiveFailuresCount(): number {
    return this.consecutiveFailures;
  }

  recordEscalation(): void {
    this.escalationCount++
  }

  shouldEscalate(): boolean {
    return this.escalationCount >= this.escalationThreshold
  }

  resetEscalation(): void {
    this.escalationCount = 0
  }

  getEscalationCount(): number {
    return this.escalationCount
  }

  getHints(): string[] {
    const hints: string[] = []
    const desc = this.currentStepDescription.toLowerCase()

    if (desc.includes('install') || desc.includes('npm') || desc.includes('pip')) {
      hints.push('Check if a lock file exists (package-lock.json, poetry.lock). If missing, run the install command first.')
    }
    if (desc.includes('test') || desc.includes('spec')) {
      hints.push('Make sure the source files exist and have real code before running tests.')
    }
    if (desc.includes('build') || desc.includes('compile')) {
      hints.push('Check that all dependencies are installed and source files are not empty.')
    }
    if (desc.includes('deploy') || desc.includes('publish')) {
      hints.push('Verify credentials and network access before deploying.')
    }
    if (this.hasRepetitiveToolCalls()) {
      hints.push('You are calling the same tool repeatedly with the same arguments. Try a different approach.')
    }
    if (this.hasConsecutiveFailures()) {
      hints.push('Multiple different tools are failing. Check if the environment is set up correctly.')
    }
    return hints
  }

  getActionableHints(): string[] {
    const hints: string[] = []
    const error = this.lastErrorOutput

    if (!error) return hints

    // Runtime incompatibility — tool/module crashes on this Node version
    if (/Cannot read properties of undefined|is not a function|is not a constructor/i.test(error)) {
      if (/node_modules/.test(error)) {
        hints.push('A dependency is incompatible with your Node.js version. Check if there is an alternative package or use a different runtime.')
      }
    }

    // TypeScript syntax errors — model generated invalid code
    if (/TS1005|TS1003|TS1109|TS1128|TS1434/i.test(error)) {
      hints.push('TypeScript syntax error. Read the error message carefully — it tells you the exact line and column. Fix the syntax before retrying.')
    }

    // TypeScript type errors — model doesn't understand the types
    if (/TS2322|TS2345|TS2769|TS7006|TS7016/i.test(error)) {
      hints.push('TypeScript type mismatch. Check the type signature of the function/API you are using. If a package lacks type declarations, install @types/<package> or use skipLibCheck.')
    }

    // Module not found — missing dependency or wrong import
    if (/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i.test(error)) {
      hints.push('Module not found. Run npm install or check if the import path is correct.')
    }

    // Permission / access errors
    if (/EACCES|EPERM|permission denied/i.test(error)) {
      hints.push('Permission denied. Check file permissions or run with appropriate privileges.')
    }

    // Network errors
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(error)) {
      hints.push('Network error. Check if the server is running and accessible.')
    }

    // Command not found
    if (/is not recognized|command not found|not found in path/i.test(error)) {
      hints.push('Command not found. Check if the tool is installed and in PATH.')
    }

    // File rewrite loop — same file keeps failing
    if (this.hasExcessiveRewrites()) {
      const file = this.getExcessiveRewriteFile()
      hints.push(`File ${file} has been rewritten ${this.getFileRewriteCount(file!)} times without success. Stop rewriting and try a fundamentally different approach.`)
    }

    return hints
  }

  getToolAlternative(): string | null {
    const tool = this.lastFailedTool
    const error = this.lastErrorOutput

    if (!tool) return null

    // If a tool fails with a runtime crash, suggest alternatives
    if (/Cannot read properties of undefined|is not a function|TypeError|ReferenceError/i.test(error)) {
      // Map of tools to their common alternatives
      const alternatives: Record<string, string> = {
        'ts-node': 'tsx',
        'jest': 'vitest',
        'mocha': 'vitest',
        'webpack': 'vite',
        'rollup': 'vite',
        'parcel': 'vite',
        'babel': 'tsc',
        'eslint': 'biome',
        'prettier': 'biome',
      }

      for (const [failed, alt] of Object.entries(alternatives)) {
        if (tool.includes(failed) || error.includes(failed)) {
          return alt
        }
      }
    }

    return null
  }

  recordFileRewrite(filePath: string): void {
    const count = (this.fileRewriteCount.get(filePath) || 0) + 1
    this.fileRewriteCount.set(filePath, count)
  }

  getFileRewriteCount(filePath: string): number {
    return this.fileRewriteCount.get(filePath) || 0
  }

  hasExcessiveRewrites(): boolean {
    return Array.from(this.fileRewriteCount.values()).some(c => c >= this.fileRewriteThreshold)
  }

  getExcessiveRewriteFile(): string | null {
    for (const [file, count] of this.fileRewriteCount) {
      if (count >= this.fileRewriteThreshold) return file
    }
    return null
  }

  getRepetitiveToolMessage(): string {
    if (!this.hasRepetitiveToolCalls()) return "";
    const last = this.recentToolCalls[this.recentToolCalls.length - 1];
    return t("exec.repetitive_tool", {
      tool: last.name,
      count: this.repetitionThreshold,
    });
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
    return "";
  }

  getRecoveryMessage(): string {
    if (this.isStuck()) {
      return t("exec.stuck_recovery", {
        iterations: this.iterationsOnCurrentStep,
        stepId: String(this.currentStepId ?? "?"),
        description: this.currentStepDescription,
      });
    }
    // Per-tool error recovery (more specific — e.g., "bash failed 3 times")
    const errorTool = Array.from(this.toolErrors.entries()).find(
      ([_, c]) => c >= this.errorThreshold,
    );
    if (errorTool) {
      return t("exec.tool_errors_recovery", {
        tool: errorTool[0],
        count: errorTool[1],
      });
    }
    // Consecutive failures from different tools (generic — e.g., "5 consecutive failures")
    if (this.hasConsecutiveFailures()) {
      return t("exec.consecutive_failures_recovery", {
        count: this.consecutiveFailures,
      });
    }
    if (this.hasRepetitiveToolCalls()) {
      return this.getRepetitiveToolMessage();
    }
    return "";
  }

  checkOffTrack(
    toolName: string,
    call: { name: string; arguments: Record<string, unknown> },
  ): string | null {
    if (!this.currentStepDescription) return null;

    const toolArgStr = JSON.stringify(call.arguments).toLowerCase();

    const pathInStep = (
      this.currentStepDescription.match(/\b[\w./-]+\.[a-z]+/gi) || []
    ).map((p) => p.toLowerCase());

    const pathInCall = (toolArgStr.match(/\b[\w./-]+\.[a-z]+/gi) || []).map(
      (p) => p.toLowerCase(),
    );

    const overlaps = pathInCall.some((p) =>
      pathInStep.some((s) => p.includes(s) || s.includes(p)),
    );

    if (!overlaps && pathInStep.length > 0 && pathInCall.length > 0) {
      return t("exec.off_track", {
        stepId: String(this.currentStepId),
        description: this.currentStepDescription,
        tool: toolName,
      });
    }

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
    this.escalationCount = 0;
  }
}
