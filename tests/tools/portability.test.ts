// Phase 3: tool portability — bash redirects, grep engine, process dedup.
import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";

// Локаль — процессный синглтон: порядок файлов в раннере зависит от ФС
// (на CI иной), поэтому файлы с английскими строками пинят "en" сами.
beforeEach(() => setLocale("en"));
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bashTool } from "../../src/tools/bash";
import { grepTool } from "../../src/tools/grep-tool";
import { processRegistry } from "../../src/modules/processes";

function bashCtx(hasTool: (n: string) => boolean) {
  return {
    baseDir: process.cwd(),
    config: { security: { enabled: false } },
    sessionId: "ses_port",
    toolExecutor: { hasTool },
  } as any;
}

describe("bash tool-as-command + --cwd", () => {
  it("redirects a registered tool name invoked as a shell command", async () => {
    const res = await bashTool.handler!(bashCtx((n) => n === "browser"), { command: "browser open" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("browser");
    expect(res.output.toLowerCase()).toContain("tool");
  });

  it("suggests workdir for a generic --cwd flag", async () => {
    const res = await bashTool.handler!(bashCtx(() => false), {
      command: "bun run build --cwd packages/app",
    });
    expect(res.success).toBe(false);
    expect(res.output).toContain("workdir");
  });

  it("does not hijack real shell commands like grep", async () => {
    // grep is a registered tool AND a shell command; NEVER_TOOL_CALLS excludes it.
    const res = await bashTool.handler!(bashCtx((n) => n === "grep"), {
      command: "grep --version",
    });
    // Should not return the tool-as-command hint.
    expect(res.output).not.toContain("not a shell command");
    expect(res.output).not.toContain("function call");
  });
});

describe("grep tool JS engine", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-grep-engine-"));
    writeFileSync(join(dir, "a.ts"), "const FINDME = 1;\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("works with the built-in JS engine (no external binary)", async () => {
    const ctx: any = {
      baseDir: dir,
      config: { security: { enabled: false }, tools: { grepEngine: "js" } },
      sessionId: "ses_grep",
    };
    const res = await grepTool.handler!(ctx, { pattern: "FINDME" });
    expect(res.success).toBe(true);
    expect(res.output).toContain("FINDME");
  });
});

describe("processRegistry dedup", () => {
  const script = join(tmpdir(), `mma-idle-${process.pid}.js`);
  beforeAll(() => writeFileSync(script, "setTimeout(() => {}, 60000);\n"));
  afterAll(() => {
    processRegistry.killAll("ses_dedup");
    rmSync(script, { force: true });
  });

  it("reuses a running process for an identical command", () => {
    const a = processRegistry.start(`node ${script}`, process.cwd(), "ses_dedup");
    const b = processRegistry.start(`node ${script}`, process.cwd(), "ses_dedup");
    expect(b.id).toBe(a.id);
  });

  it("force starts a fresh process", () => {
    const a = processRegistry.start(`node ${script}`, process.cwd(), "ses_dedup");
    const b = processRegistry.start(`node ${script}`, process.cwd(), "ses_dedup", { force: true });
    expect(b.id).not.toBe(a.id);
    processRegistry.kill(a.id);
    processRegistry.kill(b.id);
  });
});
