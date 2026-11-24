import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { Diagnostic } from "../../src/output/types";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";
import { ChangeCapture, MAX_PENDING } from "../../src/modules/changes/capture";
import { ChangesStore } from "../../src/modules/changes/store";

let root: string;
let outside: string;
let store: ChangesStore;
let capture: ChangeCapture;
const diags: Diagnostic[] = [];
const config = structuredClone(DEFAULTS) as AppConfig;
const baseDir = join(tmpdir(), "mma-workspace-fake");

const tool = (name: string): ToolDefinition => ({
  name, description: "", parameters: {}, security: { caps: [{ fs: "write" }] },
});
const ctx = (cfg: AppConfig = config): ToolContext => ({
  config: cfg, baseDir, logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  sessionId: "s1", exitOnComplete: true, contextManager: {} as never, activeToolTags: [],
  onDiagnostic: (d) => diags.push(d),
} as unknown as ToolContext);
const local = (cfg: AppConfig = config): ToolContext =>
  ({ ...ctx(cfg), baseDir: root, onDiagnostic: (d) => diags.push(d) }) as ToolContext;
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ id, name, arguments: args });
const diag = (kind: Diagnostic["kind"]) => diags.find((d) => d.kind === kind);

// Creating file symlinks needs privileges/developer mode on Windows.
const canSymlink = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "mma-capture-sym-"));
    writeFileSync(join(dir, "t"), "x");
    symlinkSync(join(dir, "t"), join(dir, "l"), "file");
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-capture-"));
  outside = mkdtempSync(join(tmpdir(), "mma-capture-out-"));
  diags.length = 0;
  store = new ChangesStore({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
  capture = new ChangeCapture(store, () => config, (d) => diags.push(d));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("ChangeCapture", () => {
  it("snapshots content before an edit and records it after success", () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "old");
    capture.before(local(), tool("write_file"), call("call1", "write_file", { path: "a.txt" }));
    writeFileSync(file, "new");
    capture.after("call1", true);
    const e = store.readEntries("s1")[0]!;
    expect(e.op).toBe("write");
    expect(store.getBlob("s1", e.before)!.toString()).toBe("old");
    expect(store.getBlob("s1", e.after)!.toString()).toBe("new");
    expect(diags).toHaveLength(0);
  });

  it("does not journal a failed write and stays fail-open", () => {
    capture.before(local(), tool("write_file"), call("call2", "write_file", { path: "missing.txt" }));
    capture.after("call2", false);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diags).toHaveLength(0);
  });

  it("records delete and move with both sides", () => {
    const file = join(root, "m.txt");
    writeFileSync(file, "data");
    const c = local();
    capture.before(c, tool("delete_file"), call("d1", "delete_file", { path: "m.txt" }));
    capture.after("d1", true);
    writeFileSync(file, "data");
    capture.before(c, tool("move_file"), call("m1", "move_file", { from: "m.txt", to: "n.txt" }));
    writeFileSync(join(root, "n.txt"), "data");
    capture.after("m1", true);
    const [del, move] = store.readEntries("s1");
    expect(del!.op).toBe("delete");
    expect(del!.after).toBeNull();
    expect(move!.op).toBe("move");
    expect(move!.to).toBe("n.txt");
    expect(move!.toBefore).toBeNull();
  });

  it("journals a too-large move with a skipped reason and both sides", () => {
    const small = structuredClone(config);
    small.changes!.maxFileBytes = 4;
    const cap = new ChangeCapture(store, () => small, (d) => diags.push(d));
    writeFileSync(join(root, "big.txt"), "0123456789");
    cap.before(local(small), tool("move_file"), call("tl", "move_file", { from: "big.txt", to: "dest.txt" }));
    cap.after("tl", true);
    const e = store.readEntries("s1")[0]!;
    expect(e.skipped).toBe("too-large");
    expect(e.to).toBe("dest.txt");
    expect(e.toBefore).toBeNull();
    expect(diag("skipped")?.detail).toMatchObject({
      callId: "tl", sessionId: "s1", path: "big.txt", call: "move_file",
    });
  });

  it.skipIf(!canSymlink)("journals a symlink move with a skipped reason but not an escaping destination", () => {
    writeFileSync(join(root, "inside.txt"), "data");
    symlinkSync(join(root, "inside.txt"), join(root, "link.txt"), "file");
    const c = local();
    capture.before(c, tool("move_file"), call("sy", "move_file", { from: "link.txt", to: "moved.txt" }));
    capture.after("sy", true);
    const e = store.readEntries("s1")[0]!;
    expect(e.skipped).toBe("unsupported");
    expect(e.to).toBe("moved.txt");
    expect(e.toBefore).toBeNull();
    capture.before(c, tool("move_file"), call("sy2", "move_file", { from: "link.txt", to: "../escape.txt" }));
    capture.after("sy2", true);
    expect(store.readEntries("s1")).toHaveLength(1);
  });

  it("journals a linked source as unsupported with both sides", () => {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "linked"), "junction");
    const c = local();
    capture.before(c, tool("move_file"), call("ln", "move_file", { from: "linked", to: "moved" }));
    capture.after("ln", true);
    const e = store.readEntries("s1")[0]!;
    expect(e.skipped).toBe("unsupported");
    expect(e.to).toBe("moved");
    expect(e.toBefore).toBeNull();
    expect(diag("skipped")?.cause).toContain("symbolic link");
  });

  it("never journals a move whose destination leaves baseDir", () => {
    writeFileSync(join(root, "m.txt"), "data");
    capture.before(local(), tool("move_file"), call("oob", "move_file", { from: "m.txt", to: "../escape.txt" }));
    capture.after("oob", true);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diag("skipped")?.cause).toContain("outside the base directory");
  });

  it("cancel() drops one pending snapshot", () => {
    writeFileSync(join(root, "a.txt"), "old");
    capture.before(local(), tool("write_file"), call("c1", "write_file", { path: "a.txt" }));
    capture.cancel("c1");
    capture.after("c1", true);
    expect(store.readEntries("s1")).toHaveLength(0);
  });

  it("clear() drops every pending snapshot", () => {
    writeFileSync(join(root, "a.txt"), "old");
    const c = local();
    capture.before(c, tool("write_file"), call("x1", "write_file", { path: "a.txt" }));
    capture.before(c, tool("write_file"), call("x2", "write_file", { path: "a.txt" }));
    capture.clear();
    capture.after("x1", true);
    capture.after("x2", true);
    expect(store.readEntries("s1")).toHaveLength(0);
  });

  it("replaces a duplicate call id and emits a skipped diagnostic", () => {
    writeFileSync(join(root, "a.txt"), "old");
    const c = local();
    capture.before(c, tool("write_file"), call("dup", "write_file", { path: "a.txt" }));
    capture.before(c, tool("write_file"), call("dup", "write_file", { path: "a.txt" }));
    expect(diag("skipped")?.cause).toContain("duplicate call id");
    capture.after("dup", true);
    expect(store.readEntries("s1")).toHaveLength(1);
  });

  it("caps pending snapshots and evicts the oldest with a diagnostic", () => {
    const c = local();
    for (let i = 0; i < MAX_PENDING; i++)
      capture.before(c, tool("write_file"), call(`p${i}`, "write_file", { path: "ghost.txt" }));
    capture.before(c, tool("write_file"), call("last", "write_file", { path: "ghost.txt" }));
    expect(diag("skipped")?.cause).toContain(`cap ${MAX_PENDING}`);
    capture.after("p0", true);
    expect(store.readEntries("s1")).toHaveLength(0);
    capture.after("last", true);
    expect(store.readEntries("s1")).toHaveLength(1);
  });

  it("re-checks the path guard in after() before reading", () => {
    writeFileSync(join(root, "g.txt"), "old");
    let checks = 0;
    const guarded = { ...local(), pathGuard: { recheck: () => {
      checks++;
      return { success: false, output: "blocked" };
    } } } as ToolContext;
    capture.before(guarded, tool("write_file"), call("g1", "write_file", { path: "g.txt" }));
    expect(checks).toBe(0);
    capture.after("g1", true);
    expect(checks).toBe(1);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diag("skipped")?.cause).toContain("path guard");
  });

  it("re-checks the move destination guard in after()", () => {
    writeFileSync(join(root, "m.txt"), "data");
    const guarded = { ...local(), pathGuard: { recheck: (p: string) =>
      p === "dest.txt" ? { success: false, output: "blocked" } : undefined,
    } } as ToolContext;
    capture.before(guarded, tool("move_file"), call("mg", "move_file", { from: "m.txt", to: "dest.txt" }));
    capture.after("mg", true);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diag("skipped")?.cause).toContain("path guard");
  });

  it("does not follow a source swapped through a linked directory in after()", () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "a.txt"), "old");
    writeFileSync(join(outside, "a.txt"), "secret");
    const c = local();
    capture.before(c, tool("write_file"), call("swap", "write_file", { path: "sub/a.txt" }));
    rmSync(join(root, "sub"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "sub"), "junction");
    capture.after("swap", true);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diag("skipped")?.cause).toContain("outside the base directory");
  });

  it("does nothing when changes.enabled is false", () => {
    const off = structuredClone(config);
    off.changes!.enabled = false;
    const cap = new ChangeCapture(store, () => off, (d) => diags.push(d));
    writeFileSync(join(root, "a.txt"), "old");
    cap.before(local(off), tool("write_file"), call("off", "write_file", { path: "a.txt" }));
    cap.after("off", true);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diags).toHaveLength(0);
  });

  it("a store failure is fail-open with contextual diagnostics", () => {
    writeFileSync(join(root, "a.txt"), "old");
    store.append = () => { throw new Error("disk full"); };
    capture.before(local(), tool("write_file"), call("fail", "write_file", { path: "a.txt" }));
    capture.after("fail", true);
    const d = diag("failed")!;
    expect(d.cause).toBe("disk full");
    expect(d.detail).toMatchObject({
      callId: "fail", sessionId: "s1", path: "a.txt", call: "write_file",
    });
  });
});
