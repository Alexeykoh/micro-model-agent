import { describe, it, expect, afterEach } from "vitest";
import { processRegistry } from "../../src/modules/processes";
import { processLogTool } from "../../src/tools/process-log";
import { processKillTool } from "../../src/tools/process-kill";
import { processWaitTool } from "../../src/tools/process-wait";
import type { ToolContext } from "../../src/tools/types";

/**
 * Фоновые процессы привязаны к сессии (аудит §4.9, план
 * `2026-10-12-harness-module-audit-fixes`, W3/Task 3.6): процесс-тулы не видят
 * и не трогают чужие процессы.
 */

function makeCtx(sessionId: string): ToolContext {
  return {
    baseDir: process.cwd(),
    config: {},
    logger: { info: () => {}, error: () => {} },
    sessionId,
  } as unknown as ToolContext;
}

const started: string[] = [];

afterEach(() => {
  for (const id of started) processRegistry.kill(id);
  started.length = 0;
});

describe("process-тулы: изоляция по сессии", () => {
  it("не читает и не убивает процесс чужой сессии", async () => {
    const entry = processRegistry.start("node -e \"setTimeout(()=>{}, 5000)\"", process.cwd(), "session-A");
    started.push(entry.id);

    const ctxB = makeCtx("session-B");

    const log = await processLogTool.handler(ctxB, { id: entry.id });
    expect(log.success).toBe(false);

    const kill = await processKillTool.handler(ctxB, { id: entry.id });
    expect(kill.success).toBe(false);

    const wait = await processWaitTool.handler(ctxB, { id: entry.id, timeoutMs: 1000 });
    expect(wait.success).toBe(false);

    // Своя сессия — процесс виден.
    const own = await processLogTool.handler(makeCtx("session-A"), { id: entry.id });
    expect(own.success).toBe(true);
  });
});
