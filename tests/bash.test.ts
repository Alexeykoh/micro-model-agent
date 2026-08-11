import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	bashTool,
	setBashGraceMs,
	detectToolCallInBash,
	parseToolArgs,
	translateSemicolonsForCmd,
	extractEchoFileWrite,
} from "../src/tools/bash";
import { processRegistry } from "../src/modules/processes";

const tmpProject = mkdtempSync(join(tmpdir(), "mma-bash-"));
const idleScript = join(tmpProject, "idle.js");
writeFileSync(idleScript, `setInterval(() => {}, 1000);`, "utf-8");
writeFileSync(
	join(tmpProject, "package.json"),
	JSON.stringify({
		name: "mma-bash-test",
		scripts: { dev: `node ${idleScript}` },
	}),
	"utf-8",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
	setBashGraceMs(5000);
	processRegistry.killAll();
	await sleep(200);
	try {
		rmSync(tmpProject, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function makeCtx(extra: Record<string, unknown> = {}) {
	return {
		baseDir: process.cwd(),
		config: {},
		logger: { info: () => {}, error: () => {} },
		...extra,
	} as any;
}

describe("bash", () => {
	it("should execute a command", async () => {
		const ctx = makeCtx();
		const result = await bashTool.handler(ctx, { command: "echo hello" });
		expect(result.success).toBe(true);
		expect(result.output.trim()).toBe("hello");
	});

	it("should handle command failure", async () => {
		const ctx = makeCtx();
		const result = await bashTool.handler(ctx, { command: "exit 1" });
		expect(result.success).toBe(false);
	});

	it("should start long-running commands in background and return a process id", async () => {
		const ctx = makeCtx({ sessionId: "bash-ses" });
		const result = await bashTool.handler(ctx, {
			command: `node ${idleScript}`,
			background: true,
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain("proc_");
		expect(result.output).toContain("PID");
		expect(result.output).toContain("process_log");

		const idMatch = result.output.match(/proc_\d+_\d+/);
		expect(idMatch).not.toBeNull();
		const entry = processRegistry.get(idMatch![0]);
		expect(entry).toBeDefined();
		expect(entry!.sessionId).toBe("bash-ses");

		processRegistry.kill(entry!.id);
		await sleep(200);
		expect(processRegistry.get(entry!.id)?.status).toBe("killed");
	});

	it("should auto-promote commands still running after the grace window", async () => {
		setBashGraceMs(200);
		const ctx = makeCtx({ baseDir: tmpProject, sessionId: "bash-ses2" });
		const result = await bashTool.handler(ctx, { command: "npm run dev" });
		expect(result.success).toBe(true);
		expect(result.output).toContain("proc_");
		expect(result.output).toContain("process_log");

		const idMatch = result.output.match(/proc_\d+_\d+/);
		expect(idMatch).not.toBeNull();
		processRegistry.kill(idMatch![0]);
	});

	it("should not background one-shot commands, even when they mention long-running words", async () => {
		const ctx = makeCtx();
		const result = await bashTool.handler(ctx, {
			command: "node -e \"console.log('vite dev server')\"",
		});
		expect(result.success).toBe(true);
		expect(result.output.trim()).toBe("vite dev server");
	});

	it("should fail with a spawn error for an invalid workdir", async () => {
		const ctx = makeCtx();
		const result = await bashTool.handler(ctx, {
			command: "echo hi",
			workdir: "E:\\definitely\\missing\\dir\\xyz",
		});
		expect(result.success).toBe(false);
		expect(result.output).toContain("[process error]");
	});
});

describe("extractEchoFileWrite", () => {
	it("detects echo redirection to a file", () => {
		expect(extractEchoFileWrite("echo 'x' > a.ts")).toBe("a.ts");
	});

	it("detects printf append redirection", () => {
		expect(extractEchoFileWrite("printf 'x' >> b.js")).toBe("b.js");
	});

	it("detects multi-line echo writes (broken in cmd.exe)", () => {
		expect(
			extractEchoFileWrite("echo 'if (!x) {\n  console.log(1);\n}' > app.ts"),
		).toBe("app.ts");
	});

	it("returns null when no redirection target", () => {
		expect(extractEchoFileWrite("echo hello")).toBeNull();
		expect(extractEchoFileWrite("bun test")).toBeNull();
	});
});

describe("translateSemicolonsForCmd", () => {
	it("replaces ; separators with & outside quotes", () => {
		expect(translateSemicolonsForCmd("node a.ts; echo ok")).toBe(
			"node a.ts& echo ok",
		);
	});

	it("keeps ; inside double-quoted strings intact", () => {
		expect(translateSemicolonsForCmd('echo "a;b"')).toBe('echo "a;b"');
	});

	it("handles mixed quoted and unquoted semicolons", () => {
		expect(translateSemicolonsForCmd('cmd1; echo "x;y"; cmd2')).toBe(
			'cmd1& echo "x;y"& cmd2',
		);
	});

	it("leaves commands without semicolons untouched", () => {
		expect(translateSemicolonsForCmd("bun test")).toBe("bun test");
	});
});

describe("detectToolCallInBash", () => {
	it("should detect a tool call with key=value args", () => {
		const result = detectToolCallInBash("create_dir path=E:\\project\\src");
		expect(result).toEqual({
			tool: "create_dir",
			args: "path=E:\\project\\src",
		});
	});

	it("should detect a tool call with JSON args", () => {
		const result = detectToolCallInBash(
			'read_file {"path":"src/x.ts","limit":50}',
		);
		expect(result).toEqual({
			tool: "read_file",
			args: '{"path":"src/x.ts","limit":50}',
		});
	});

	it("should return null for plain commands", () => {
		expect(detectToolCallInBash("echo hello")).toBeNull();
		expect(detectToolCallInBash("ls -la")).toBeNull();
		expect(detectToolCallInBash("npm test")).toBeNull();
	});

	it("should not treat shell commands with = signs as tool calls", () => {
		// echo/cat with content containing '=' are shell commands, not tool invocations
		expect(detectToolCallInBash("echo 'x=1'")).toBeNull();
		expect(detectToolCallInBash("cat src/wordcount.ts")).toBeNull();
		expect(detectToolCallInBash('printf "a=b"')).toBeNull();
	});

	it("should return null for commands without = or JSON", () => {
		expect(detectToolCallInBash("bun init")).toBeNull();
	});

	it("should not match hyphenated commands as tool names", () => {
		expect(detectToolCallInBash("npm-run-all test=1")).toBeNull();
	});
});

describe("parseToolArgs", () => {
	it("should parse JSON args", () => {
		expect(parseToolArgs('{"path":"src/x.ts","limit":50}')).toEqual({
			path: "src/x.ts",
			limit: 50,
		});
	});

	it("should parse key=value pairs", () => {
		expect(parseToolArgs("path=E:\\project\\src")).toEqual({
			path: "E:\\project\\src",
		});
	});

	it("should strip surrounding quotes", () => {
		expect(parseToolArgs('path="E:\\project\\src"')).toEqual({
			path: "E:\\project\\src",
		});
	});

	it("should parse multiple key=value tokens", () => {
		expect(parseToolArgs('action=create title="My Task"')).toEqual({
			action: "create",
			title: "My Task",
		});
	});
});

describe("bash tool-call redirection", () => {
	it("should redirect a mistaken tool call into the real tool", async () => {
		const realToolResult = { success: true, output: "Created dir" };
		const toolExecutor = {
			executeByName: async (name: string) => {
				expect(name).toBe("create_dir");
				return realToolResult;
			},
			hasTool: (name: string) => name === "create_dir",
		};
		const ctx = makeCtx({ toolExecutor });
		const result = await bashTool.handler(ctx, {
			command: "create_dir path=E:\\project\\src",
		});
		expect(result.success).toBe(true);
		expect(result.output).toContain('[redirected to tool "create_dir"]');
		expect(result.output).toContain("Created dir");
	});

	it("should not redirect when toolExecutor is missing", async () => {
		const ctx = makeCtx();
		const result = await bashTool.handler(ctx, {
			command: "create_dir path=E:\\project\\src",
		});
		expect(result.success).toBe(false);
		expect(result.output).not.toContain("[redirected to tool");
	});

	it("should not redirect bash into itself", async () => {
		const toolExecutor = {
			executeByName: async () => ({ success: true, output: "x" }),
		};
		const ctx = makeCtx({ toolExecutor });
		const result = await bashTool.handler(ctx, {
			command: "bash echo=hello",
		});
		// No redirection — runs through cmd.exe (may fail on the bogus command).
		expect(result.output).not.toContain('[redirected to tool "bash"]');
	});
});
