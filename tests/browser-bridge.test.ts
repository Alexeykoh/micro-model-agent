import { describe, expect, it, vi, afterEach } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import * as childProcess from "child_process";
import { BridgeDriver } from "../src/modules/browser/bridge-client";

function fakeChild(): any {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function failingChild(err: Error): any {
  const child = fakeChild();
  setImmediate(() => {
    child.emit("error", err);
  });
  return child;
}

function exitingChild(stderrText: string, code = 1): any {
  const child = fakeChild();
  setImmediate(() => {
    child.stderr.emit("data", Buffer.from(stderrText));
    child.emit("exit", code);
  });
  return child;
}

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("BridgeDriver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pings the node bridge over stdio", async () => {
    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await bridge.launch({
      headless: true,
      viewport: { width: 640, height: 480 },
      timeoutMs: 15000,
    });

    const title = await bridge.title();
    expect(title).toBe("");

    const cookies = await bridge.cookies();
    expect(Array.isArray(cookies)).toBe(true);

    await bridge.close();
  });

  it("fails cleanly on timeout-less shutdown", async () => {
    const bridge = new BridgeDriver();
    // close() without launch must not throw
    await bridge.close();
  });

  it("rejects launch with the spawn error text when node cannot start", async () => {
    const err = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    const spy = vi.spyOn(childProcess, "spawn");
    spy.mockImplementationOnce(() => failingChild(err));

    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await expect(
      bridge.launch({
        headless: true,
        viewport: { width: 640, height: 480 },
        timeoutMs: 15000,
      }),
    ).rejects.toThrow(/spawn node ENOENT/);

    // pending map must be cleared after the failure — no leak
    expect((bridge as any).pending.size).toBe(0);
  });

  it("rejects launch with the stderr tail when the bridge exits early", async () => {
    const spy = vi.spyOn(childProcess, "spawn");
    spy.mockImplementationOnce(() => exitingChild("boom stderr\n"));

    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await expect(
      bridge.launch({
        headless: true,
        viewport: { width: 640, height: 480 },
        timeoutMs: 15000,
      }),
    ).rejects.toThrow(/boom stderr/);
    expect((bridge as any).pending.size).toBe(0);
  });

  it("one-shot restart: a dead bridge is respawned on the next send", async () => {
    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await bridge.launch({
      headless: true,
      viewport: { width: 640, height: 480 },
      timeoutMs: 15000,
    });

    // Kill the child; the exit handler must clear proc/rl
    const inner = (bridge as any).proc;
    inner.kill();
    await waitFor(() => (bridge as any).proc === null);

    // Next send respawns the bridge transparently
    const title = await bridge.title();
    expect(title).toBe("");

    await bridge.close();
  });

  it("close() does not respawn a dead bridge", async () => {
    const spy = vi.spyOn(childProcess, "spawn");
    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await bridge.launch({
      headless: true,
      viewport: { width: 640, height: 480 },
      timeoutMs: 15000,
    });

    const inner = (bridge as any).proc;
    inner.kill();
    await waitFor(() => (bridge as any).proc === null);

    const spawnCalls = spy.mock.calls.length;
    await bridge.close(); // must not spawn a new bridge just to close it
    expect(spy.mock.calls.length).toBe(spawnCalls);
  });
});