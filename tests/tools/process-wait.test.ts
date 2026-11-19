import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";

// Локаль — процессный синглтон: порядок файлов в раннере зависит от ФС
// (на CI иной), поэтому файлы с английскими строками пинят "en" сами.
beforeEach(() => setLocale("en"));
import { processWaitTool } from "../../src/tools/process-wait";
import { processRegistry } from "../../src/modules/processes";

const startedIds: string[] = [];

function track(id: string): string {
  startedIds.push(id);
  return id;
}

afterEach(() => {
  for (const id of startedIds.splice(0)) {
    try {
      processRegistry.remove(id);
    } catch {
      // already gone — nothing to clean
    }
  }
});

describe("process_wait", () => {
  it("reports exit code and output for a finished process", async () => {
    const entry = processRegistry.start(
      `${process.execPath} -e "console.log('hello-wait'); process.exit(3)"`,
      process.cwd(),
      "test",
    );
    track(entry.id);
    const res = await processWaitTool.handler!({} as any, { id: entry.id, timeoutMs: 15000 } as any);
    expect(res.success).toBe(true);
    expect(res.output).toContain("3");
    expect(res.output).toContain("hello-wait");
  });

  it("reports still-running on timeout instead of hanging", async () => {
    const entry = processRegistry.start(
      `${process.execPath} -e "setTimeout(() => {}, 60000)"`,
      process.cwd(),
      "test",
    );
    track(entry.id);
    const started = Date.now();
    const res = await processWaitTool.handler!({} as any, { id: entry.id, timeoutMs: 1000 } as any);
    const elapsed = Date.now() - started;
    expect(res.success).toBe(true);
    expect(res.output.toLowerCase()).toContain("still running");
    expect(res.output).toContain("process_wait");
    expect(elapsed).toBeLessThan(15000);
    expect(processRegistry.get(entry.id)?.status).toBe("running");
  });
});
