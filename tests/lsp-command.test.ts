import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { resolveSpawnCommand, buildWinCommandLine } from "../src/modules/lsp/command";

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
    expect(resolveSpawnCommand("rust-analyzer", "darwin", "")).toBe("rust-analyzer");
  });

  it("resolves a bare command to its .cmd shim on Windows when present in PATH", () => {
    writeFileSync(join(tmp, "npx.cmd"), "@echo off", "utf-8");
    expect(resolveSpawnCommand("npx", "win32", tmp)).toBe("npx.cmd");
  });

  it("resolves to .exe when no .cmd shim exists", () => {
    writeFileSync(join(tmp, "rust-analyzer.exe"), "", "utf-8");
    expect(resolveSpawnCommand("rust-analyzer", "win32", tmp)).toBe("rust-analyzer.exe");
  });

  it("prefers .cmd over .exe when both exist", () => {
    writeFileSync(join(tmp, "tool.cmd"), "@echo off", "utf-8");
    writeFileSync(join(tmp, "tool.exe"), "", "utf-8");
    expect(resolveSpawnCommand("tool", "win32", tmp)).toBe("tool.cmd");
  });

  it("returns the command unchanged when it already has an extension", () => {
    writeFileSync(join(tmp, "custom.cmd"), "@echo off", "utf-8");
    expect(resolveSpawnCommand("custom.cmd", "win32", tmp)).toBe("custom.cmd");
  });

  it("returns the command unchanged when it is a path", () => {
    expect(resolveSpawnCommand("C:\\tools\\npx.cmd", "win32", tmp)).toBe("C:\\tools\\npx.cmd");
    expect(resolveSpawnCommand("/usr/bin/npx", "win32", tmp)).toBe("/usr/bin/npx");
  });

  it("returns the bare command when no shim is found in PATH", () => {
    expect(resolveSpawnCommand("missing-cmd", "win32", tmp)).toBe("missing-cmd");
  });
});

describe("buildWinCommandLine", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lsp-line-"));
  });

  afterEach(() => {
    try {
      if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("joins command and args without quoting simple tokens", () => {
    expect(buildWinCommandLine("npx.cmd", ["--version"])).toBe("npx.cmd --version");
    expect(buildWinCommandLine("npx.cmd", ["typescript-language-server", "--stdio"])).toBe(
      "npx.cmd typescript-language-server --stdio",
    );
  });

  it("quotes arguments containing cmd.exe metacharacters", () => {
    expect(buildWinCommandLine("npx.cmd", ["--path", "a b"])).toBe('npx.cmd --path "a b"');
    expect(buildWinCommandLine("npx.cmd", ["x&y"])).toBe('npx.cmd "x&y"');
  });

  it("spawns a .cmd shim through the shell on win32 (no EINVAL)", async () => {
    // The exact failure mode observed across an entire session: under Node
    // `spawn("npx.cmd", args)` with no shell throws `spawn EINVAL`. Running
    // the resolved command line through `cmd.exe /d /s /c` (shell: true)
    // must actually launch the .cmd shim. Skipped on non-Windows where the
    // client never takes the shell path.
    if (process.platform !== "win32") return;

    const shim = join(tmp, "lsp-probe.cmd");
    writeFileSync(shim, "@echo ok", "utf-8");

    const line = buildWinCommandLine(shim, []);
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn(line, [], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });
      let data = "";
      proc.stdout?.on("data", (d) => (data += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve(data) : reject(new Error(`exit ${code}`))));
    });
    expect(out.trim()).toBe("ok");
  });
});
