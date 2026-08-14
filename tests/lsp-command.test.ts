import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveSpawnCommand } from "../src/modules/lsp/command";

describe("resolveSpawnCommand", () => {
	let tmp = "";

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "lsp-cmd-"));
	});

	afterEach(() => {
		try {
			if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
		} catch {}
	});

	it("returns the command unchanged on non-Windows platforms", () => {
		expect(resolveSpawnCommand("npx", "linux", "")).toBe("npx");
		expect(resolveSpawnCommand("rust-analyzer", "darwin", "")).toBe(
			"rust-analyzer",
		);
	});

	it("resolves a bare command to its .cmd shim on Windows when present in PATH", () => {
		writeFileSync(join(tmp, "npx.cmd"), "@echo off", "utf-8");
		expect(resolveSpawnCommand("npx", "win32", tmp)).toBe("npx.cmd");
	});

	it("resolves to .exe when no .cmd shim exists", () => {
		writeFileSync(join(tmp, "rust-analyzer.exe"), "", "utf-8");
		expect(resolveSpawnCommand("rust-analyzer", "win32", tmp)).toBe(
			"rust-analyzer.exe",
		);
	});

	it("prefers .cmd over .exe when both exist", () => {
		writeFileSync(join(tmp, "tool.cmd"), "@echo off", "utf-8");
		writeFileSync(join(tmp, "tool.exe"), "", "utf-8");
		expect(resolveSpawnCommand("tool", "win32", tmp)).toBe("tool.cmd");
	});

	it("returns the command unchanged when it already has an extension", () => {
		writeFileSync(join(tmp, "custom.cmd"), "@echo off", "utf-8");
		expect(resolveSpawnCommand("custom.cmd", "win32", tmp)).toBe(
			"custom.cmd",
		);
	});

	it("returns the command unchanged when it is a path", () => {
		expect(resolveSpawnCommand("C:\\tools\\npx.cmd", "win32", tmp)).toBe(
			"C:\\tools\\npx.cmd",
		);
		expect(resolveSpawnCommand("/usr/bin/npx", "win32", tmp)).toBe(
			"/usr/bin/npx",
		);
	});

	it("returns the bare command when no shim is found in PATH", () => {
		expect(resolveSpawnCommand("missing-cmd", "win32", tmp)).toBe(
			"missing-cmd",
		);
	});
});
