import { t } from "../../i18n/index";

interface ToolCallRecord {
	name: string;
	argsKey: string;
}

export type ErrorClassification = "transient" | "systematic" | "blocking";

const TRANSIENT_PATTERNS = [
	/timeout/i,
	/timed out/i,
	/ECONNREFUSED/i,
	/ETIMEDOUT/i,
	/ECONNRESET/i,
	/killed/i,
	/SIGTERM/i,
	/SIGKILL/i,
	/rate limit/i,
	/429/i,
	/503/i,
	/502/i,
];

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
	for (const p of TRANSIENT_PATTERNS) {
		if (p.test(output)) return "transient";
	}
	for (const p of BLOCKING_PATTERNS) {
		if (p.test(output)) return "blocking";
	}
	return "systematic";
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

	constructor(threshold = 6, errorThreshold = 3) {
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

	getLastBashCommand(): string {
		return this.lastBashCommand;
	}

	getLastBashOutput(): string {
		return this.lastBashOutput;
	}

	getLastFailedTool(): string {
		return this.lastFailedTool;
	}

	getIterationsOnCurrentStep(): number {
		return this.iterationsOnCurrentStep;
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

		if (
			desc.includes("install") ||
			desc.includes("npm") ||
			desc.includes("pip")
		) {
			hints.push(
				"Check if a lock file exists (package-lock.json, poetry.lock). If missing, run the install command first.",
			);
		}
		if (desc.includes("test") || desc.includes("spec")) {
			hints.push(
				"Make sure the source files exist and have real code before running tests.",
			);
		}
		if (desc.includes("build") || desc.includes("compile")) {
			hints.push(
				"Check that all dependencies are installed and source files are not empty.",
			);
		}
		if (desc.includes("deploy") || desc.includes("publish")) {
			hints.push("Verify credentials and network access before deploying.");
		}
		if (this.hasRepetitiveToolCalls()) {
			hints.push(
				"You are calling the same tool repeatedly with the same arguments. Try a different approach.",
			);
		}
		if (this.hasConsecutiveFailures()) {
			hints.push(
				"Multiple different tools are failing. Check if the environment is set up correctly.",
			);
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
		if (
			isScriptRun &&
			!this.lastBashOutput.trim() &&
			this.emptyBashRunCount >= 2
		) {
			hints.push(
				`The command "${this.lastBashCommand}" ran ${this.emptyBashRunCount} times with EMPTY output. The program likely has no entry point — read the file with read_file and check that it actually calls its main function with process.argv / CLI arguments and prints results (console.log). Then run it again.`,
			);
		}

		if (!error) return hints;

		// Runtime incompatibility — tool/module crashes on this Node version
		if (
			/Cannot read properties of undefined|is not a function|is not a constructor/i.test(
				error,
			)
		) {
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
		if (
			/Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i.test(error)
		) {
			hints.push(
				"Module not found. Run npm install or check if the import path is correct.",
			);
		}

		// Permission / access errors
		if (/EACCES|EPERM|permission denied/i.test(error)) {
			hints.push(
				"Permission denied. Check file permissions or run with appropriate privileges.",
			);
		}

		// Network errors
		if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(error)) {
			hints.push(
				"Network error. Check if the server is running and accessible.",
			);
		}

		// Command not found
		if (/is not recognized|command not found|not found in path/i.test(error)) {
			hints.push(
				"Command not found. Check if the tool is installed and in PATH.",
			);
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
		if (
			/Write-Host|Get-Content|Select-String|Out-File|Set-Content/i.test(error)
		) {
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
			/Cannot read properties of undefined|is not a function|TypeError|ReferenceError/i.test(
				error,
			)
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
		return Array.from(this.fileRewriteCount.values()).some(
			(c) => c >= this.fileRewriteThreshold,
		);
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
		// Preserve escalationCount — prevents agent from "gaming" stuck detection
		// by marking a step done and moving to the next one
	}
}
