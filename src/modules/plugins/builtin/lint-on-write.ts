import type { AgentPlugin } from "../../types";
import type { ToolContext, ToolCall, ToolResult } from "../../../tools/types";
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve, extname, join } from "path";
import { platform } from "os";

const TYPE_CHECK_DEBOUNCE_MS = 2000;

// Per-file syntax checks are cached by (path, content hash): re-writing a file
// with identical content skips the (expensive) check. Content changes → cache
// miss → fresh check.
const syntaxCache = new Map<string, { hash: string; error: string | null }>();

function contentHash(content: string): string {
	let h = 5381;
	for (let i = 0; i < content.length; i++) {
		h = ((h << 5) + h + content.charCodeAt(i)) | 0;
	}
	return String(h);
}

let _winDecoder: TextDecoder | null | undefined;

function getWinDecoder(): TextDecoder {
	if (_winDecoder === undefined) {
		if (platform() !== "win32") {
			_winDecoder = null;
		} else {
			try {
				const cpOut = execSync("chcp.com", {
					encoding: "buffer",
					timeout: 2000,
					windowsHide: true,
				}).toString("latin1");
				const m = cpOut.match(/(\d+)/);
				_winDecoder = m ? new TextDecoder("ibm" + m[1]) : null;
			} catch {
				_winDecoder = null;
			}
		}
	}
	return _winDecoder ?? new TextDecoder("utf-8");
}

export class LintOnWritePlugin implements AgentPlugin {
	name = "lint-on-write";
	priority = 10;
	private _checkPromise: Promise<string | null> | null = null;
	private _checkTimestamp = 0;

	async onAfterTool(
		ctx: ToolContext,
		call: ToolCall,
		result: ToolResult,
	): Promise<void> {
		if (call.name !== "write_file" && call.name !== "edit_file") {
			return;
		}

		if (!result.success) {
			return;
		}

		const path = String(call.arguments.path || "");
		if (!path) return;

		const fullPath = resolve(ctx.baseDir, path);
		if (!existsSync(fullPath)) return;

		const ext = extname(fullPath);
		const syntaxError = await this.checkSyntax(fullPath, ext, ctx.baseDir);

		if (syntaxError) {
			result.output += `\n\n[Syntax check failed]: ${syntaxError}`;
			return;
		}

		await this.runProjectLint(ctx, result);
		await this.runProjectTypeCheck(ctx, result);
	}

	private async checkSyntax(
		filePath: string,
		ext: string,
		baseDir: string,
	): Promise<string | null> {
		if (ext === ".ts" || ext === ".tsx") {
			// Syntax-only check via bun's parser (~200ms) instead of `npx tsc`
			// (~3-5s per write). Full type errors are still surfaced by the
			// debounced project typecheck below when a tsconfig exists.
			let content = "";
			try {
				content = readFileSync(filePath, "utf-8");
			} catch {
				return null;
			}
			const hash = contentHash(content);
			const cached = syntaxCache.get(filePath);
			if (cached && cached.hash === hash) {
				return cached.error;
			}
			try {
				await runAsync(
					`bun build --no-bundle --target=bun "${filePath}"`,
					baseDir,
					10000,
				);
				syntaxCache.set(filePath, { hash, error: null });
				return null;
			} catch (err: any) {
				if (
					err.status === 127 ||
					err.message.includes("not found") ||
					err.message.includes("ENOENT")
				) {
					return null;
				}
				const stderr = err.stderr?.toString() || err.stdout?.toString() || "";
				const firstError =
					stderr.split("\n").find((line: string) => line.trim()) ||
					"TypeScript syntax error";
				syntaxCache.set(filePath, { hash, error: firstError.trim() });
				return firstError.trim();
			}
		}

		if (ext === ".js" || ext === ".jsx") {
			try {
				await runAsync(`node --check "${filePath}"`, baseDir, 5000);
				return null;
			} catch (err: any) {
				const stderr = err.stderr?.toString() || "";
				const firstError =
					stderr.split("\n").find((line: string) => line.trim()) ||
					"JavaScript syntax error";
				return firstError.trim();
			}
		}

		return null;
	}

	private async runProjectLint(
		ctx: ToolContext,
		result: ToolResult,
	): Promise<void> {
		try {
			const packageJsonPath = join(ctx.baseDir, "package.json");
			if (!existsSync(packageJsonPath)) {
				return;
			}

			const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
			const lintScript = packageJson.scripts?.lint;

			if (!lintScript) {
				return;
			}

			ctx.logger.debug(`Running lint: ${lintScript}`);
			await runAsync(lintScript, ctx.baseDir, 30_000);
			ctx.logger.debug("Lint passed");
		} catch (err: any) {
			ctx.logger.warn(`Lint failed: ${err.message}`);
			result.output += `\n\n[Project lint failed]: ${err.message}`;
		}
	}

	private async runProjectTypeCheck(
		ctx: ToolContext,
		result: ToolResult,
	): Promise<void> {
		const tsconfigPath = join(ctx.baseDir, "tsconfig.json");
		if (!existsSync(tsconfigPath)) {
			return;
		}

		const now = Date.now();
		if (
			this._checkPromise &&
			now - this._checkTimestamp < TYPE_CHECK_DEBOUNCE_MS
		) {
			const error = await this._checkPromise;
			if (error) {
				result.output += `\n\n[Project typecheck failed]: ${error}`;
			}
			return;
		}

		this._checkTimestamp = now;
		this._checkPromise = this.runTscCheck(ctx.baseDir);
		const error = await this._checkPromise;
		if (error) {
			result.output += `\n\n[Project typecheck failed]: ${error}`;
		}
	}

	private async runTscCheck(baseDir: string): Promise<string | null> {
		try {
			await runAsync(`npx tsc --noEmit --skipLibCheck`, baseDir, 30000);
			return null;
		} catch (err: any) {
			if (
				err.status === 127 ||
				err.message.includes("not found") ||
				err.message.includes("ENOENT")
			) {
				return null;
			}
			const stderr = err.stderr?.toString() || err.stdout?.toString() || "";
			if (stderr.includes("error TS")) {
				const firstError =
					stderr
						.split("\n")
						.find((line: string) => line.includes("error TS")) ||
					"TypeScript type error";
				return firstError.trim();
			}
			return null;
		}
	}
}

/**
 * Run a command asynchronously (non-blocking event loop) and resolve when it
 * exits. Rejects with captured stderr/stdout on non-zero exit or timeout.
 */
function runAsync(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const decoder = getWinDecoder();
		child.stdout?.on("data", (d: Buffer) => {
			stdout += decoder.decode(d, { stream: true });
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += decoder.decode(d, { stream: true });
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			stdout += decoder.decode();
			stderr += decoder.decode();
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				const err: any = new Error(`Command failed with exit code ${code}`);
				err.stdout = stdout;
				err.stderr = stderr;
				err.status = code;
				reject(err);
			}
		});
	});
}

export const plugin = new LintOnWritePlugin();
