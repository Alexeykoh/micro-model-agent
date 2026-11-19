import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ExecutionModule } from "../src/modules/execution/module";

describe("forbidden Windows command hard-stop", () => {
  let tmpDir: string;
  let execModule: ExecutionModule;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-forbid-"));
    execModule = new ExecutionModule(tmpDir, 8);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  // Hard-stop живёт под `platform() === "win32"` в execution-plugin: на macOS/Linux
  // grep/sed/ls существуют, и фейл по ним — законная причина, а не «нет cmd.exe».
  it.skipIf(process.platform !== "win32")("queues the STOP system-summary after two bash failures with the same forbidden command", async () => {
    const plugin = execModule.getPlugin();
    const messages: string[] = [];
    const ctx: any = {
      contextManager: {
        addMessage: (m: any) => messages.push(String(m?.content ?? "")),
      },
    };
    const call: any = {
      name: "bash",
      arguments: { command: "grep -n foo bar" },
    };
    const result: any = {
      success: false,
      output: "'grep' is not recognized...",
    };

    // First failure — no STOP yet.
    plugin.onAfterTool(ctx, call, result);
    plugin.onBeforeThink(ctx);
    expect(messages.some((m) => m.includes('STOP using "grep"'))).toBe(false);

    // Second failure — STOP is queued and flushed into the context.
    plugin.onAfterTool(ctx, call, result);
    plugin.onBeforeThink(ctx);
      expect(messages.some((m) => m.includes('STOP using "grep"'))).toBe(true);
  });
});
