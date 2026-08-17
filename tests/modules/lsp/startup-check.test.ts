import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runStartupHealthCheck, parseTscErrors } from "../../../src/modules/lsp/startup-check";
import type { LspConfig, LspDiagnostic, LspServerConfig } from "../../../src/modules/lsp/types";
import { LspClient } from "../../../src/modules/lsp/client";

const DEFAULT_LSP_CONFIG: LspConfig = {
	enabled: true,
	servers: {
		typescript: {
			command: "mock",
			args: [],
			workspaceMarkers: ["package.json", "tsconfig.json"],
		} as LspServerConfig,
	},
	timeout: 30000,
};

const LSP_CONFIG_WITH_SERVER = DEFAULT_LSP_CONFIG;

describe("startup-check", () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "mma-startup-check-"));
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		mkdirSync(tmpDir, { recursive: true });
	});

	describe("parseTscErrors", () => {
		it("parses error TS lines from tsc output", () => {
			const out = `src/a.ts(3,1): error TS2304: Cannot find name 'x'.
src/b.ts(5,2): error TS2322: Type 'string' is not assignable to type 'number'.
Info: some other line
src/c.ts(1,1): error TS1234: Another error.`;
			const errors = parseTscErrors(out);
			expect(errors).toEqual([
				"src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
				"src/b.ts(5,2): error TS2322: Type 'string' is not assignable to type 'number'.",
				"src/c.ts(1,1): error TS1234: Another error.",
			]);
		});

		it("deduplicates identical error lines", () => {
			const out = `src/a.ts(3,1): error TS2304: Cannot find name 'x'.
src/a.ts(3,1): error TS2304: Cannot find name 'x'.`;
			const errors = parseTscErrors(out);
			expect(errors).toEqual(["src/a.ts(3,1): error TS2304: Cannot find name 'x'."]);
		});

		it("handles Windows drive letters", () => {
			const out = `C:\\project\\src\\a.ts(3,1): error TS2304: Cannot find name 'x'.`;
			const errors = parseTscErrors(out);
			// replace(/^[a-zA-Z]:/, '') leaves leading backslash
			expect(errors).toEqual(["\\project\\src\\a.ts(3,1): error TS2304: Cannot find name 'x'."]);
		});
	});

	describe("runStartupHealthCheck", () => {
		it("returns null when config.enabled is false", async () => {
			const result = await runStartupHealthCheck(
				{ ...DEFAULT_LSP_CONFIG, enabled: false },
				tmpDir,
			);
			expect(result).toBeNull();
		});

		it("returns null for clean injectable tsc runner", async () => {
			writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
			const result = await runStartupHealthCheck(
				DEFAULT_LSP_CONFIG,
				tmpDir,
				{
					runTsc: async () => [],
				},
			);
			expect(result).toBeNull();
		});

		it("returns PromptBlock with errors from injectable tsc runner", async () => {
			writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
			const result = await runStartupHealthCheck(
				DEFAULT_LSP_CONFIG,
				tmpDir,
				{
					runTsc: async () => [
						"src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
						"src/b.ts(5,2): error TS2322: Type 'string' is not assignable to type 'number'.",
					],
				},
			);
			expect(result).not.toBeNull();
			expect(result!.content).toContain(
				"[Existing project errors (checked at session start) — fix these before continuing]:",
			);
			expect(result!.content).toContain("src/a.ts(3,1): error TS2304");
			expect(result!.content).toContain("src/b.ts(5,2): error TS2322");
			expect(result!.priority).toBe("high");
			expect(result!.essential).toBe(false);
			expect(result!.estimatedTokens).toBeGreaterThan(0);
		});

		it("caps error lines at STARTUP_CHECK_ERROR_CAP (20)", async () => {
			writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
			const manyErrors = Array.from({ length: 25 }, (_, i) =>
				`src/file${i}.ts(1,1): error TS2304: Error ${i}.`,
			);
			const result = await runStartupHealthCheck(
				DEFAULT_LSP_CONFIG,
				tmpDir,
				{ runTsc: async () => manyErrors },
			);
			expect(result).not.toBeNull();
			const lines = result!.content.split("\n").slice(1); // skip header
			expect(lines.length).toBe(20);
		});

		it("uses mocked LSP client for non-tsconfig projects", async () => {
			// Create a test file that collectCheckFiles will find
			writeFileSync(join(tmpDir, "test.ts"), "const x = 1;\n");
			writeFileSync(join(tmpDir, "package.json"), "{}");
			const mockClient = {
				checkFile: async (
					_file: string,
					_baseDir: string,
					_server: any,
					_root: string,
				): Promise<LspDiagnostic[]> => {
					return [
						{
							range: {
								start: { line: 0, character: 0 },
								end: { line: 0, character: 10 },
							},
							severity: 1,
							message: "LSP error",
							source: "mock",
						},
					];
				},
			} as LspClient;

			const result = await runStartupHealthCheck(
				LSP_CONFIG_WITH_SERVER,
				tmpDir,
				{
					client: mockClient,
					runTsc: async () => {
						throw new Error("should not be called for non-tsconfig");
					},
				},
			);
			expect(result).not.toBeNull();
			expect(result!.content).toContain("LSP error");
		});

		it("ignores warnings (severity 2) in LSP fallback", async () => {
			writeFileSync(join(tmpDir, "test.ts"), "const x = 1;\n");
			writeFileSync(join(tmpDir, "package.json"), "{}");
			const mockClient = {
				checkFile: async () =>
					[
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							severity: 1,
							message: "error",
							source: "mock",
						},
						{
							range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
							severity: 2,
							message: "warning",
							source: "mock",
						},
					] as LspDiagnostic[],
			} as LspClient;

			const result = await runStartupHealthCheck(
				LSP_CONFIG_WITH_SERVER,
				tmpDir,
				{ client: mockClient },
			);
			expect(result).not.toBeNull();
			expect(result!.content).toContain("error");
			expect(result!.content).not.toContain("warning");
		});

		it("skips files when LSP server config not found", async () => {
			const mockClient = {
				checkFile: async () => [],
			} as LspClient;

			const result = await runStartupHealthCheck(
				{ ...DEFAULT_LSP_CONFIG, servers: [] },
				tmpDir,
				{ client: mockClient },
			);
			expect(result).toBeNull();
		});

		it("handles LSP client throwing gracefully (fail-open)", async () => {
			const mockClient = {
				checkFile: async () => {
					throw new Error("LSP server crash");
				},
			} as LspClient;

			const result = await runStartupHealthCheck(
				LSP_CONFIG_WITH_SERVER,
				tmpDir,
				{ client: mockClient },
			);
			expect(result).toBeNull();
		});
	});
});