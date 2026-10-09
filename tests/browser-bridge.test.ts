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

// A healthy bridge child that answers every request over stdio.
function respondingChild(): any {
  const child = fakeChild();
  child.stdin.on("data", (chunk: Buffer) => {
    const msg = JSON.parse(chunk.toString());
    const line = Buffer.from(`${JSON.stringify({ id: msg.id, ok: true, data: {} })}\n`);
    child.stdout.emit("data", line);
  });
  return child;
}

// Like respondingChild but answers after a delay — keeps a send in flight so a
// test can interleave a stale child's exit between the request and the reply.
function slowRespondingChild(delayMs = 50): any {
  const child = fakeChild();
  child.stdin.on("data", (chunk: Buffer) => {
    const msg = JSON.parse(chunk.toString());
    setTimeout(() => {
      const line = Buffer.from(`${JSON.stringify({ id: msg.id, ok: true, data: {} })}\n`);
      child.stdout.emit("data", line);
    }, delayMs);
  });
  return child;
}

// A failed spawn whose "exit" is fired on demand — lets a test land a stale
// child's exit after a newer bridge is already alive.
function errorThenControlledExitChild(err: Error): { child: any; fireExit: () => void } {
  const child = fakeChild();
  setImmediate(() => child.emit("error", err));
  return { child, fireExit: () => child.emit("exit", 1) };
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

  // Real cross-process node bridge (+ browser). CI runners have no browser
  // runtime, so the bridge exits and the ping times out — same rationale as
  // BrowserSession's unconditional skip. Covered on a dev machine.
  it.skipIf(Boolean(process.env.CI))("pings the node bridge over stdio", async () => {
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

  it.skipIf(Boolean(process.env.CI))("one-shot restart: a dead bridge is respawned on the next send", async () => {
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

  it.skipIf(Boolean(process.env.CI))("close() does not respawn a dead bridge", async () => {
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

  it("one-shot restart: a failed respawn rejects instead of looping", async () => {
    const err = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    const spy = vi.spyOn(childProcess, "spawn");
    spy.mockImplementationOnce(() => failingChild(err));
    spy.mockImplementationOnce(() => failingChild(err));

    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await expect(
      bridge.launch({
        headless: true,
        viewport: { width: 640, height: 480 },
        timeoutMs: 15000,
      }),
    ).rejects.toThrow(/spawn node ENOENT/);

    // The next send respawns the bridge; when that respawn also fails the
    // send rejects with the spawn error — no infinite respawn loop, no child leak.
    await expect(bridge.title()).rejects.toThrow(/spawn node ENOENT/);
    expect((bridge as any).proc).toBeNull();
    expect((bridge as any).pending.size).toBe(0);
  });

  it("a stale child's delayed exit cannot clobber the respawned bridge", async () => {
    const err = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
    const spy = vi.spyOn(childProcess, "spawn");
    const { child: staleChild, fireExit } = errorThenControlledExitChild(err);
    spy.mockImplementationOnce(() => staleChild);
    spy.mockImplementationOnce(() => slowRespondingChild());

    const bridge = new BridgeDriver({ maxConsoleLineChars: 100 });
    await expect(
      bridge.launch({
        headless: true,
        viewport: { width: 640, height: 480 },
        timeoutMs: 15000,
      }),
    ).rejects.toThrow(/spawn node ENOENT/);

    // Land proc1's delayed "exit" while the respawned proc2 is live and has a
    // request in flight — it must not null the new bridge's refs.
    setImmediate(() => fireExit());

    const title = await bridge.title();
    expect(title).toBe("");
    expect((bridge as any).proc).not.toBeNull();

    await bridge.close();
  });
});
