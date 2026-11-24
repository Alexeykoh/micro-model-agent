import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { ToolContext, ToolDefinition } from "../../src/tools/types";
import { ChangeCapture } from "../../src/modules/changes/capture";
import { ChangesStore } from "../../src/modules/changes/store";

let root: string;
let store: ChangesStore;
let capture: ChangeCapture;
const diags: unknown[] = [];
const config = structuredClone(DEFAULTS) as AppConfig;
const baseDir = join(tmpdir(), "mma-workspace-fake");

const tool = (name: string): ToolDefinition => ({
  name, description: "", parameters: {}, security: { caps: [{ fs: "write" }] },
});
const ctx = (): ToolContext => ({
  config, baseDir, logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  sessionId: "s1", exitOnComplete: true, contextManager: {} as never, activeToolTags: [],
  onDiagnostic: (d) => diags.push(d),
} as unknown as ToolContext);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-capture-"));
  diags.length = 0;
  store = new ChangesStore({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
  capture = new ChangeCapture(store, config, (d) => diags.push(d));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangeCapture", () => {
  it("snapshots content before an edit and records it after success", () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "old");
    const c = ctx();
    capture.before({ ...c, baseDir: root }, tool("write_file"), {
      id: "call1", name: "write_file", arguments: { path: "a.txt" },
    });
    writeFileSync(file, "new");
    capture.after("call1", true);
    const e = store.readEntries("s1")[0]!;
    expect(e.op).toBe("write");
    expect(store.getBlob("s1", e.before)!.toString()).toBe("old");
    expect(store.getBlob("s1", e.after)!.toString()).toBe("new");
    expect(diags).toHaveLength(0);
  });

  it("does not journal a failed write and stays fail-open", () => {
    const c = ctx();
    capture.before({ ...c, baseDir: root }, tool("write_file"), {
      id: "call2", name: "write_file", arguments: { path: "missing.txt" },
    });
    capture.after("call2", false);
    expect(store.readEntries("s1")).toHaveLength(0);
    expect(diags).toHaveLength(0);
  });

  it("records delete and move with both sides", () => {
    const file = join(root, "m.txt");
    writeFileSync(file, "data");
    const c = { ...ctx(), baseDir: root };
    capture.before(c, tool("delete_file"), {
      id: "d1", name: "delete_file", arguments: { path: "m.txt" },
    });
    capture.after("d1", true);
    writeFileSync(file, "data");
    capture.before(c, tool("move_file"), {
      id: "m1", name: "move_file", arguments: { from: "m.txt", to: "n.txt" },
    });
    writeFileSync(join(root, "n.txt"), "data");
    capture.after("m1", true);
    const [del, move] = store.readEntries("s1");
    expect(del!.op).toBe("delete");
    expect(del!.after).toBeNull();
    expect(move!.op).toBe("move");
    expect(move!.to).toBe("n.txt");
    expect(move!.toBefore).toBeNull();
  });
});
