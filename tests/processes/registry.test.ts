import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { processRegistry } from "../../src/modules/processes";

const tickScript = join(tmpdir(), `mma-tick-${process.pid}.js`);
writeFileSync(tickScript, `setInterval(() => console.log('tick'), 50);`, "utf-8");

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

  it("waitForExit resolves true for a quick process", async () => {
    const entry = processRegistry.start("node -p 1", process.cwd(), "ses-wfe");
    const exited = await processRegistry.waitForExit(entry.id, 3000);
    expect(exited).toBe(true);
    expect(processRegistry.get(entry.id)?.status).toBe("exited");
  });

  it("waitForExit resolves false for a still-running process", async () => {
    const entry = processRegistry.start(`node ${idleScript}`, process.cwd(), "ses-wfe2");
    const exited = await processRegistry.waitForExit(entry.id, 150);
    expect(exited).toBe(false);
    processRegistry.kill(entry.id);
  });

  it("remove deletes a finished entry", async () => {
    const entry = processRegistry.start("node -p 1", process.cwd(), "ses-rm");
    await processRegistry.waitForExit(entry.id, 3000);
    expect(processRegistry.remove(entry.id)).toBe(true);
    expect(processRegistry.get(entry.id)).toBeUndefined();
    expect(processRegistry.remove(entry.id)).toBe(false);
  });

  it("remove kills and deletes a running entry", async () => {
    const entry = processRegistry.start(`node ${idleScript}`, process.cwd(), "ses-rm2");
    await new Promise((r) => setTimeout(r, 100));
    expect(processRegistry.remove(entry.id)).toBe(true);
    expect(processRegistry.get(entry.id)).toBeUndefined();
  });

  it("records a spawn error for an invalid workdir", async () => {
    const entry = processRegistry.start("node -p 1", "Z:\\no\\such\\dir", "ses-err");
    const exited = await processRegistry.waitForExit(entry.id, 3000);
    expect(exited).toBe(true);
    expect(entry.spawnError).toBeTruthy();
    expect(processRegistry.getLog(entry.id)).toContain("[process error]");
  });
});

describe("processRegistry encoding (R1)", () => {
  it("decodes Russian UTF-8 output from a bun child process cleanly", async () => {
    const entry = processRegistry.start(
      `bun -e "console.log('Тест кириллицы: анализ транзакций')"`,
      process.cwd(),
      "ses-enc",
    );
    const done = await processRegistry.waitForExit(entry.id, 15000);
    expect(done).toBe(true);
    const joined = entry.log.join("\n");
    expect(joined).toContain("Тест кириллицы: анализ транзакций");
    expect(joined).not.toMatch(/╨|╤|╥/); // no mojibake
    processRegistry.remove(entry.id);
  });

  it("decodes mixed ASCII + Russian output without garbling", async () => {
    const entry = processRegistry.start(
      `bun -e "console.log('OK ' + 'Привет мир')"`,
      process.cwd(),
      "ses-enc2",
    );
    const done = await processRegistry.waitForExit(entry.id, 15000);
    expect(done).toBe(true);
    const joined = entry.log.join("\n");
    expect(joined).toContain("OK Привет мир");
    expect(joined).not.toMatch(/╨|╤|╥/);
    processRegistry.remove(entry.id);
  });
});
