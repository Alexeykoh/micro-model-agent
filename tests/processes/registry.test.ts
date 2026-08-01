import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { processRegistry } from "../../src/modules/processes";

const tickScript = join(tmpdir(), `mma-tick-${process.pid}.js`);
writeFileSync(
  tickScript,
  `setInterval(() => console.log('tick'), 50);`,
  "utf-8",
);

const idleScript = join(tmpdir(), `mma-idle-${process.pid}.js`);
writeFileSync(idleScript, `setInterval(() => {}, 1000);`, "utf-8");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  processRegistry.killAll();
  await sleep(300);
  try {
    rmSync(tickScript, { force: true });
    rmSync(idleScript, { force: true });
  } catch {
    /* ignore */
  }
});

describe("processRegistry", () => {
  it("starts a background process and reports it as running", async () => {
    const entry = processRegistry.start(`node ${idleScript}`, process.cwd(), "ses-test");
    expect(entry.status).toBe("running");
    expect(entry.pid).toBeGreaterThan(0);
    expect(entry.id).toMatch(/^proc_/);
    expect(entry.sessionId).toBe("ses-test");

    const listed = processRegistry.list("ses-test");
    expect(listed.some((p) => p.id === entry.id)).toBe(true);

    processRegistry.kill(entry.id);
    await sleep(300);
    expect(processRegistry.get(entry.id)?.status).toBe("killed");
  });

  it("buffers stdout output", async () => {
    const entry = processRegistry.start(`node ${tickScript}`, process.cwd(), "ses-log");
    await sleep(350);
    const log = processRegistry.getLog(entry.id);
    expect(log).toContain("tick");
    processRegistry.kill(entry.id);
  });

  it("tracks natural exit", async () => {
    const entry = processRegistry.start("node -p 1", process.cwd(), "ses-exit");
    await sleep(300);
    expect(processRegistry.get(entry.id)?.status).toBe("exited");
    expect(processRegistry.get(entry.id)?.exitCode).toBe(0);
  });

  it("killAll stops everything for a session", async () => {
    const a = processRegistry.start(`node ${idleScript}`, process.cwd(), "ses-clean");
    const b = processRegistry.start(`node ${idleScript}`, process.cwd(), "ses-clean");
    const count = processRegistry.killAll("ses-clean");
    expect(count).toBeGreaterThanOrEqual(2);
    await sleep(300);
    expect(processRegistry.get(a.id)?.status).toBe("killed");
    expect(processRegistry.get(b.id)?.status).toBe("killed");
  });

  it("returns empty log for unknown process", () => {
    expect(processRegistry.getLog("nope")).toBe("");
    expect(processRegistry.get("nope")).toBeUndefined();
    expect(processRegistry.kill("nope")).toBe(false);
  });
});
