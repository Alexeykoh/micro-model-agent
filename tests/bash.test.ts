import { describe, it, expect, afterAll, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  bashTool,
  setBashGraceMs,
  detectToolCallInBash,
  parseToolArgs,
  translateSemicolonsForCmd,
  extractEchoFileWrite,
  detectTestResults,
  emptyCliRunHint,
  npmExecHint,
  interactivePromptHint,
  resetBashFailureTracking,
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

// Grace-окно — модульное состояние: тест "auto-promote" ставит 200ms, и без
// сброса следующая одноразовая команда под нагрузкой уходит в фон (node
// стартует дольше 200ms) → флейк. Возвращаем дефолт после каждого теста.
afterEach(() => {
  setBashGraceMs(5000);
});

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

  it("hard-blocks a command after repeated consecutive failures (win32 only)", async () => {
    const { platform } = await import("os");
    if (platform() !== "win32") return; // head works on POSIX

    resetBashFailureTracking();
    const ctx = makeCtx();
    const filePath = join(tmpProject, "samples.txt");
    writeFileSync(filePath, "a\nb\nc\n", "utf-8");

    const r1 = await bashTool.handler(ctx, { command: "head -30 samples.txt" });
    expect(r1.success).toBe(false);
    expect(r1.output).toContain("Hint");

    const r2 = await bashTool.handler(ctx, { command: "head -10 samples.txt" });
    expect(r2.success).toBe(false);
    expect(r2.output).toContain("Hint");

    const r3 = await bashTool.handler(ctx, { command: "head -5 samples.txt" });
    expect(r3.success).toBe(false);
    expect(r3.output).toContain("STOP");
    resetBashFailureTracking();
  });

  it("hints on the ORIGINAL first word even when it was translated (cat→type)", async () => {
    const { platform } = await import("os");
    if (platform() !== "win32") return; // cat works on POSIX

    resetBashFailureTracking();
    const ctx = makeCtx();
    // `cat` is translated to `type` by adaptCommandForWindows; the hint/block
    // must still key on `cat` (ses_mssx0k11: model ran cat 4× with no hint).
    const r = await bashTool.handler(ctx, { command: "cat does-not-exist.txt" });
    expect(r.output).toContain("cat");
    expect(r.output).toContain("read_file");
  });

  it("should start long-running commands in background and return a process id", async () => {
    const ctx = makeCtx({ sessionId: "bash-ses", config: { security: { enabled: false } } });
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
    const ctx = makeCtx({ config: { security: { enabled: false } } });
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

  it("appends the npm exec hint when npx hits a package with no bin", async () => {
    // An earlier test leaves the grace window at 200ms; npm needs ~1s to
    // install, so restore the default or the command gets auto-promoted to
    // the background and reports success even on failure.
    setBashGraceMs(5000);

    // npm install + npx under parallel test load can exceed vitest's default
    // 5s timeout — give the real npm a generous window.
    // Skip when npm is not available — the pure npmExecHint tests above
    // cover the logic regardless of environment.
    const npmCheck = await bashTool.handler(makeCtx(), {
      command: "npm --version",
    });
    if (!npmCheck.success) return;

    const base = mkdtempSync(join(tmpdir(), "mma-npmexec-"));
    const pkg = join(base, "pkg");
    const app = join(base, "app");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "no-bin-pkg", version: "1.0.0" }),
      "utf-8",
    );
    writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n", "utf-8");
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify({ name: "app", version: "1.0.0" }),
      "utf-8",
    );

    try {
      const install = await bashTool.handler(makeCtx({ baseDir: app }), {
        command: `npm install ${pkg} --no-save`,
      });
      expect(install.success).toBe(true);

      // no-bin-pkg is installed but declares no bin → npx must fail with
      // "could not determine executable to run", and the tool appends the hint.
      const npxRun = await bashTool.handler(makeCtx({ baseDir: app }), {
        command: "npx no-bin-pkg",
      });
      expect(npxRun.success).toBe(false);
      expect(npxRun.output).toContain("could not determine executable to run");
      expect(npxRun.output).toContain("Hint:");
      expect(npxRun.output).toContain("bunx <pkg>");
    } finally {
      try {
        rmSync(base, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
});

describe("extractEchoFileWrite", () => {
  it("detects echo redirection to a file", () => {
    expect(extractEchoFileWrite("echo 'x' > a.ts")).toBe("a.ts");
  });

  it("detects printf append redirection", () => {
    expect(extractEchoFileWrite("printf 'x' >> b.js")).toBe("b.js");
  });

  it("detects multi-line echo writes (broken in cmd.exe)", () => {
    expect(extractEchoFileWrite("echo 'if (!x) {\n  console.log(1);\n}' > app.ts")).toBe("app.ts");
  });

  it("returns null when no redirection target", () => {
    expect(extractEchoFileWrite("echo hello")).toBeNull();
    expect(extractEchoFileWrite("bun test")).toBeNull();
  });
});

describe("translateSemicolonsForCmd", () => {
  it("replaces ; separators with & outside quotes", () => {
    expect(translateSemicolonsForCmd("node a.ts; echo ok")).toBe("node a.ts& echo ok");
  });

  it("keeps ; inside double-quoted strings intact", () => {
    expect(translateSemicolonsForCmd('echo "a;b"')).toBe('echo "a;b"');
  });

  it("handles mixed quoted and unquoted semicolons", () => {
    expect(translateSemicolonsForCmd('cmd1; echo "x;y"; cmd2')).toBe('cmd1& echo "x;y"& cmd2');
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
    const result = detectToolCallInBash('read_file {"path":"src/x.ts","limit":50}');
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

describe("detectTestResults", () => {
  it("detects bun test failing run from markers and summary", () => {
    const out = [
      "(pass) CSV Transaction Analyzer > должен парсить CSV [1.77ms]",
      "(fail) CSV Transaction Analyzer > должен обрабатывать пустой файл [0.31ms]",
      "",
      " 8 pass",
      " 3 fail",
      "22 expect() calls",
      "Ran 11 tests across 1 file. [46.00ms]",
    ].join("\n");
    const r = detectTestResults(out);
    expect(r).not.toBeNull();
    expect(r!.failed).toBe(3);
    expect(r!.passed).toBe(8);
    expect(r!.framework).toBe("bun/vitest");
  });

  it("detects all-passing bun test run", () => {
    const out = [
      "(pass) test one",
      "(pass) test two",
      "",
      " 2 pass",
      "Ran 2 tests across 1 file.",
    ].join("\n");
    const r = detectTestResults(out);
    expect(r).not.toBeNull();
    expect(r!.failed).toBe(0);
    expect(r!.passed).toBe(2);
  });

  it("detects jest summary", () => {
    const r = detectTestResults("Tests: 5 passed, 2 failed\nTest Suites: 1 failed");
    expect(r).not.toBeNull();
    expect(r!.framework).toBe("jest");
    expect(r!.failed).toBe(2);
    expect(r!.passed).toBe(5);
  });

  it("detects mocha failing count", () => {
    const r = detectTestResults("9 passing (1s)\n2 failing\n1 pending");
    expect(r).not.toBeNull();
    expect(r!.framework).toBe("mocha");
    expect(r!.failed).toBe(2);
    expect(r!.passed).toBe(9);
  });

  it("returns null for non-test output", () => {
    expect(detectTestResults("bun run build\n✓ built in 728ms")).toBeNull();
    expect(detectTestResults("")).toBeNull();
    expect(detectTestResults("No tests found")).toBeNull();
  });

  it("counts only the failing summary when vitest reports bare numbers", () => {
    // Some runners print only the aggregate line without (pass)/(fail) markers.
    const r = detectTestResults(" 7 pass\n 1 fail\nRan 8 tests");
    expect(r).not.toBeNull();
    expect(r!.failed).toBe(1);
    expect(r!.passed).toBe(7);
  });
});

describe("emptyCliRunHint (R5)", () => {
  it("hints about a missing entry point when a .ts file ran with empty output", () => {
    const h = emptyCliRunHint("bun run src/cli.ts data.csv", "", 0);
    expect(h).not.toBeNull();
    expect(h!).toContain("entry point");
  });

  it("matches a bare interpreter invocation without 'run'", () => {
    expect(emptyCliRunHint("bun src/cli.ts", "", 0)).not.toBeNull();
    expect(emptyCliRunHint("node index.js", "", 0)).not.toBeNull();
    expect(emptyCliRunHint("python script.py", "", 0)).not.toBeNull();
  });

  it("does not fire for non-empty output or non-zero exit", () => {
    expect(emptyCliRunHint("bun run src/cli.ts", "done\n", 0)).toBeNull();
    expect(emptyCliRunHint("bun run src/cli.ts", "", 1)).toBeNull();
  });

  it("does not fire for test runners or non-file commands", () => {
    expect(emptyCliRunHint("bun test", "", 0)).toBeNull();
    expect(emptyCliRunHint("bun run build", "", 0)).toBeNull();
    expect(emptyCliRunHint("npm run dev", "", 0)).toBeNull();
  });

  it("does not fire when output is redirected to a file", () => {
    expect(emptyCliRunHint("bun run src/cli.ts > out.txt", "", 0)).toBeNull();
  });
});

describe("npmExecHint (Task E)", () => {
  it("appends the hint when output contains 'could not determine executable to run'", () => {
    const out = "npm error could not determine executable to run\nnpm error log path...";
    const r = npmExecHint(out);
    expect(r).toContain("could not determine executable to run");
    expect(r).toContain('Hint: "could not determine executable to run"');
    expect(r).toContain("bunx <pkg>");
    expect(r.startsWith(out)).toBe(true);
  });

  it("is case-insensitive", () => {
    const r = npmExecHint("npm error Could not Determine Executable to Run");
    expect(r).toContain("Hint:");
  });

  it("returns the output unchanged for unrelated errors", () => {
    const out = "sh: foo: command not found";
    expect(npmExecHint(out)).toBe(out);
  });

  it("returns the output unchanged for successful runs", () => {
    const out = "hello world";
    expect(npmExecHint(out)).toBe(out);
  });
});

describe("interactivePromptHint", () => {
  it("appends a non-interactive remedy on 'Operation cancelled'", () => {
    const out = "Scaffolding project...\nOperation cancelled";
    const r = interactivePromptHint(out);
    expect(r.startsWith(out)).toBe(true);
    expect(r).toContain("Hint:");
    expect(r).toContain("non-interactively");
  });

  it("detects the no-TTY stdin error", () => {
    const r = interactivePromptHint("Error: stdin is not a TTY");
    expect(r).toContain("Hint:");
  });

  it("returns unrelated output unchanged", () => {
    const out = "added 42 packages in 3s";
    expect(interactivePromptHint(out)).toBe(out);
  });
});

describe("bash tool Windows guidance (R6)", () => {
  it("lists PowerShell cmdlet and heredoc anti-patterns in the description", () => {
    expect(bashTool.description).toContain("Write-Host");
    expect(bashTool.description).toContain("cmd.exe");
    expect(bashTool.description).toContain("heredoc");
  });
});
