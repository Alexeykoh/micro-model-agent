import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { ChangesStore } from "../../src/modules/changes/store";
import type { ChangeEntry, UndoOptions } from "../../src/modules/changes/types";
import { ChangeUndo } from "../../src/modules/changes/undo";

let root: string;
let outsideRoot: string;
let config: AppConfig;
let store: ChangesStore;
let undoer: ChangeUndo;

/** File symlinks need elevation on Windows; junctions work and read as symlinks. */
const link = (target: string, at: string): void => {
  try {
    symlinkSync(target, at);
  } catch (err) {
    if (
      process.platform === "win32" &&
      (err as NodeJS.ErrnoException).code === "EPERM"
    ) {
      symlinkSync(target, at, "junction");
    } else throw err;
  }
};

const entry = (over: Partial<ChangeEntry>): ChangeEntry => ({
  v: 1,
  id: `ch_${Math.random().toString(36).slice(2)}`,
  ts: new Date().toISOString(),
  turn: 1,
  tool: "write_file",
  callId: "c",
  op: "write",
  path: "a.txt",
  pathAbs: join(root, "a.txt"),
  before: null,
  after: null,
  bytes: 3,
  ...over,
});

const opts = (over: Partial<UndoOptions> = {}): UndoOptions => ({
  sessionId: "s1",
  baseDir: root,
  ...over,
});
const read = (name: string): string => readFileSync(join(root, name), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-undo-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "mma-undo-out-"));
  mkdirSync(join(root, "sessions", "s1"), { recursive: true });
  config = structuredClone(DEFAULTS) as AppConfig;
  store = new ChangesStore({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
  undoer = new ChangeUndo({ store, getConfig: () => config, baseDir: root });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe("ChangeUndo", () => {
  it("restores content from before a write and steps back through history", () => {
    const old1 = store.putBlob("s1", Buffer.from("v1"));
    const old2 = store.putBlob("s1", Buffer.from("v2"));
    const after2 = store.putBlob("s1", Buffer.from("v3"));
    writeFileSync(join(root, "a.txt"), "v3");
    store.append("s1", entry({ id: "e1", before: old1, after: old2 }));
    store.append("s1", entry({ id: "e2", before: old2, after: after2 }));

    expect(undoer.undo(opts({ path: "a.txt" })).ok).toBe(true);
    expect(read("a.txt")).toBe("v2");
    expect(undoer.undo(opts({ path: "a.txt" })).ok).toBe(true);
    expect(read("a.txt")).toBe("v1");
    expect(undoer.undo(opts({ path: "a.txt" })).ok).toBe(false);
  });

  it("jumps back several versions in one steps=N undo", () => {
    const v1 = store.putBlob("s1", Buffer.from("v1"));
    const v2 = store.putBlob("s1", Buffer.from("v2"));
    const v3 = store.putBlob("s1", Buffer.from("v3"));
    writeFileSync(join(root, "a.txt"), "v3");
    store.append("s1", entry({ id: "e1", before: v1, after: v2 }));
    store.append("s1", entry({ id: "e2", before: v2, after: v3 }));

    expect(undoer.undo(opts({ path: "a.txt", steps: 2 })).ok).toBe(true);
    expect(read("a.txt")).toBe("v1");
    // Both consumed revisions are invalidated, not just the restore target.
    expect(undoer.list({ sessionId: "s1", baseDir: root })).toHaveLength(0);
    expect(undoer.undo(opts({ path: "a.txt" })).ok).toBe(false);
    expect(undoer.undo(opts({ path: "a.txt", steps: 2 })).ok).toBe(false);
  });

  it("deletes a created file and recreates a deleted one", () => {
    const content = store.putBlob("s1", Buffer.from("payload"));
    writeFileSync(join(root, "new.txt"), "payload");
    store.append(
      "s1",
      entry({
        id: "c",
        op: "write",
        path: "new.txt",
        pathAbs: join(root, "new.txt"),
        before: null,
        after: content,
      }),
    );
    store.append(
      "s1",
      entry({
        id: "d",
        op: "delete",
        path: "gone.txt",
        pathAbs: join(root, "gone.txt"),
        before: content,
        after: null,
      }),
    );

    expect(undoer.undo(opts({ path: "new.txt" })).ok).toBe(true);
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    expect(undoer.undo(opts({ path: "gone.txt" })).ok).toBe(true);
    expect(read("gone.txt")).toBe("payload");
  });

  it("refuses on conflict unless force is set", () => {
    const before = store.putBlob("s1", Buffer.from("v1"));
    const after = store.putBlob("s1", Buffer.from("v2"));
    writeFileSync(join(root, "a.txt"), "v2");
    store.append("s1", entry({ id: "w", before, after }));
    writeFileSync(join(root, "a.txt"), "hand-edited");

    const conflict = undoer.undo(opts({ path: "a.txt" }));
    expect(conflict.ok).toBe(false);
    expect(conflict.items[0]!.reason).toContain("changed");
    expect(read("a.txt")).toBe("hand-edited");
    expect(undoer.undo(opts({ path: "a.txt", force: true })).ok).toBe(true);
    expect(read("a.txt")).toBe("v1");
  });

  it("undoes a whole turn and skips conflicting entries", () => {
    const before = store.putBlob("s1", Buffer.from("before"));
    const after = store.putBlob("s1", Buffer.from("after"));
    writeFileSync(join(root, "a.txt"), "after");
    writeFileSync(join(root, "b.txt"), "hand-edited");
    store.append("s1", entry({ id: "t1", turn: 7, before, after }));
    store.append(
      "s1",
      entry({
        id: "t2",
        turn: 7,
        path: "b.txt",
        pathAbs: join(root, "b.txt"),
        before,
        after,
      }),
    );

    const res = undoer.undo(opts({ turn: 7 }));
    expect(res.ok).toBe(true);
    expect(read("a.txt")).toBe("before");
    expect(read("b.txt")).toBe("hand-edited");
    expect(res.items.filter((i) => !i.ok)).toHaveLength(1);
  });

  it("reports evicted snapshots as unavailable", () => {
    const before = store.putBlob("s1", Buffer.from("old"));
    store.append("s1", entry({ id: "x", before, after: null }));
    store.append(
      "s1",
      entry({
        id: "ev",
        op: "evicted",
        targetId: "x",
        path: "a.txt",
        pathAbs: join(root, "a.txt"),
        before: null,
        after: null,
      }),
    );

    const res = undoer.undo(opts({ path: "a.txt" }));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("evicted");
  });

  it("reports insufficient history", () => {
    expect(undoer.undo(opts({ path: "a.txt" })).message).toContain("not enough");
    const before = store.putBlob("s1", Buffer.from("v1"));
    const after = store.putBlob("s1", Buffer.from("v2"));
    writeFileSync(join(root, "a.txt"), "v2");
    store.append("s1", entry({ id: "e", before, after }));
    expect(undoer.undo(opts({ path: "a.txt", steps: 2 })).ok).toBe(false);
  });

  it("undoes a move on both source and destination", () => {
    const src = store.putBlob("s1", Buffer.from("source"));
    const dstBefore = store.putBlob("s1", Buffer.from("old-dest"));
    writeFileSync(join(root, "dst.txt"), "source");
    store.append(
      "s1",
      entry({
        id: "m",
        op: "move",
        path: "src.txt",
        pathAbs: join(root, "src.txt"),
        before: src,
        after: null,
        to: "dst.txt",
        toBefore: dstBefore,
      }),
    );

    expect(undoer.undo(opts({ path: "src.txt" })).ok).toBe(true);
    expect(read("src.txt")).toBe("source");
    expect(read("dst.txt")).toBe("old-dest");
  });

  it("refuses a move undo when the destination changed, unless forced", () => {
    const src = store.putBlob("s1", Buffer.from("source"));
    const dstBefore = store.putBlob("s1", Buffer.from("old-dest"));
    writeFileSync(join(root, "dst.txt"), "source");
    store.append(
      "s1",
      entry({
        id: "m",
        op: "move",
        path: "src.txt",
        pathAbs: join(root, "src.txt"),
        before: src,
        after: null,
        to: "dst.txt",
        toBefore: dstBefore,
      }),
    );
    writeFileSync(join(root, "dst.txt"), "hand-edited");

    expect(undoer.undo(opts({ path: "src.txt" })).ok).toBe(false);
    expect(undoer.undo(opts({ path: "src.txt", force: true })).ok).toBe(true);
    expect(read("dst.txt")).toBe("old-dest");
  });

  it("refuses paths outside the base directory even with force", () => {
    const outside = resolve(root, "..", "outside.txt");
    expect(undoer.undo(opts({ path: "../outside.txt", force: true })).ok).toBe(
      false,
    );
    expect(existsSync(outside)).toBe(false);

    const before = store.putBlob("s1", Buffer.from("secret"));
    store.append(
      "s1",
      entry({ id: "bad", path: "a.txt", pathAbs: outside, before, after: null }),
    );
    const res = undoer.undo(opts({ turn: 1, force: true }));
    expect(res.ok).toBe(false);
    expect(res.items[0]!.reason).toContain("outside");
    expect(existsSync(outside)).toBe(false);
  });

  it("lists bounded, filtered, newest-first live changes", () => {
    for (let i = 0; i < 5; i++) {
      store.append("s1", entry({ id: `e${i}` }));
    }
    store.append(
      "s1",
      entry({ id: "other", path: "b.txt", pathAbs: join(root, "b.txt") }),
    );
    expect(undoer.list({ sessionId: "s1", baseDir: root })).toHaveLength(6);
    expect(
      undoer.list({ sessionId: "s1", baseDir: root, limit: 2 }).map((e) => e.id),
    ).toEqual(["other", "e4"]);
    expect(
      undoer.list({ sessionId: "s1", baseDir: root, path: "b.txt" }),
    ).toHaveLength(1);
  });

  it("returns an UndoResult for invalid steps and clamps list limit", () => {
    const zero = undoer.undo(opts({ path: "a.txt", steps: 0 }));
    expect(zero.ok).toBe(false);
    expect(zero.message).toContain("invalid steps");
    expect(undoer.undo(opts({ path: "a.txt", steps: 1.5 })).ok).toBe(false);
    for (let i = 0; i < 60; i++) {
      store.append("s1", entry({ id: `e${i}` }));
    }
    expect(
      undoer.list({ sessionId: "s1", baseDir: root, limit: 1000 }),
    ).toHaveLength(50);
    expect(
      undoer.list({ sessionId: "s1", baseDir: root, limit: -5 }),
    ).toHaveLength(0);
  });

  it("caps generated diff output", () => {
    const lines = (word: string) =>
      Array.from({ length: 320 }, (_, i) => `${word}-${i}`).join("\n");
    const before = store.putBlob("s1", Buffer.from(lines("old")));
    const after = store.putBlob("s1", Buffer.from(lines("new")));
    writeFileSync(join(root, "a.txt"), lines("new"));
    store.append("s1", entry({ id: "d", before, after }));
    const res = undoer.undo(opts({ path: "a.txt" }));
    expect(res.ok).toBe(true);
    expect(res.diff!.split("\n").length).toBeLessThanOrEqual(301);
  });

  it("refuses a symlinked source path even with force", () => {
    link(outsideRoot, join(root, "a.txt"));
    const before = store.putBlob("s1", Buffer.from("old"));
    store.append("s1", entry({ id: "s", before, after: null }));
    const res = undoer.undo(opts({ path: "a.txt", force: true }));
    expect(res.ok).toBe(false);
    expect(res.items[0]!.reason).toContain("symbolic link");
  });

  it("refuses a source reached through a symlinked parent", () => {
    mkdirSync(join(outsideRoot, "sub"), { recursive: true });
    writeFileSync(join(outsideRoot, "sub", "a.txt"), "secret");
    link(join(outsideRoot, "sub"), join(root, "sub"));
    const before = store.putBlob("s1", Buffer.from("restored"));
    store.append(
      "s1",
      entry({
        id: "p",
        path: "sub/a.txt",
        pathAbs: join(root, "sub", "a.txt"),
        before,
        after: null,
      }),
    );
    const res = undoer.undo(opts({ path: "sub/a.txt", force: true }));
    expect(res.ok).toBe(false);
    expect(res.items[0]!.reason).toContain("outside");
    expect(readFileSync(join(outsideRoot, "sub", "a.txt"), "utf8")).toBe(
      "secret",
    );
  });

  it("refuses a symlinked move destination", () => {
    writeFileSync(join(outsideRoot, "dst.txt"), "outside-content");
    link(outsideRoot, join(root, "dst"));
    const src = store.putBlob("s1", Buffer.from("source"));
    const toBefore = store.putBlob("s1", Buffer.from("old"));
    store.append(
      "s1",
      entry({
        id: "m",
        op: "move",
        path: "src.txt",
        pathAbs: join(root, "src.txt"),
        before: src,
        after: null,
        to: "dst",
        toBefore,
      }),
    );
    const res = undoer.undo(opts({ path: "src.txt", force: true }));
    expect(res.ok).toBe(false);
    expect(res.items[0]!.reason).toContain("move destination");
    expect(readFileSync(join(outsideRoot, "dst.txt"), "utf8")).toBe(
      "outside-content",
    );
  });

  it("does not half-restore a move when the destination blob is missing", () => {
    const src = store.putBlob("s1", Buffer.from("source"));
    const lost = store.putBlob("s1", Buffer.from("lost"));
    rmSync(join(store.dir("s1"), "blobs", lost.slice(0, 2), `${lost}.gz`));
    writeFileSync(join(root, "dst.txt"), "source");
    store.append(
      "s1",
      entry({
        id: "m",
        op: "move",
        path: "src.txt",
        pathAbs: join(root, "src.txt"),
        before: src,
        after: null,
        to: "dst.txt",
        toBefore: lost,
      }),
    );
    const res = undoer.undo(opts({ path: "src.txt" }));
    expect(res.ok).toBe(false);
    expect(existsSync(join(root, "src.txt"))).toBe(false);
    expect(read("dst.txt")).toBe("source");
    expect(store.readEntries("s1").filter((e) => e.op === "undo")).toHaveLength(0);
  });

  it("honors authorize: no write and no marker when a path is denied", () => {
    const before = store.putBlob("s1", Buffer.from("old"));
    const after = store.putBlob("s1", Buffer.from("new"));
    writeFileSync(join(root, "a.txt"), "new");
    store.append("s1", entry({ id: "auth", before, after }));
    const seen: string[] = [];
    const res = undoer.undo(
      opts({
        path: "a.txt",
        force: true,
        authorize: (p) => {
          seen.push(p);
          return p === join(root, "a.txt") ? "blocked by policy" : null;
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.items[0]!.reason).toContain("blocked by policy");
    expect(read("a.txt")).toBe("new");
    expect(store.readEntries("s1").filter((e) => e.op === "undo")).toHaveLength(0);
    expect(seen).toContain(join(root, "a.txt"));
  });

  it("authorizes the directory creation target before writing", () => {
    const before = store.putBlob("s1", Buffer.from("restored"));
    store.append(
      "s1",
      entry({
        id: "dir",
        path: "sub/a.txt",
        pathAbs: join(root, "sub", "a.txt"),
        before,
        after: null,
      }),
    );
    const res = undoer.undo(
      opts({
        path: "sub/a.txt",
        authorize: (p) => (p === join(root, "sub") ? "dir denied" : null),
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.items[0]!.reason).toContain("dir denied");
    expect(existsSync(join(root, "sub"))).toBe(false);
  });

  it("authorizes a move destination before any write, ignoring force", () => {
    const src = store.putBlob("s1", Buffer.from("source"));
    const toBefore = store.putBlob("s1", Buffer.from("old"));
    writeFileSync(join(root, "dst.txt"), "source");
    store.append(
      "s1",
      entry({
        id: "m",
        op: "move",
        path: "src.txt",
        pathAbs: join(root, "src.txt"),
        before: src,
        after: null,
        to: "dst.txt",
        toBefore,
      }),
    );
    const res = undoer.undo(
      opts({
        path: "src.txt",
        force: true,
        authorize: (p) =>
          p === join(root, "dst.txt") ? "destination denied" : null,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.items[0]!.reason).toContain("destination denied");
    expect(existsSync(join(root, "src.txt"))).toBe(false);
    expect(read("dst.txt")).toBe("source");
    expect(store.readEntries("s1").filter((e) => e.op === "undo")).toHaveLength(0);
  });
});

describe("ChangesStore.evict", () => {
  it("evicts the oldest revisions beyond maxRevisionsPerFile", () => {
    config.changes!.maxRevisionsPerFile = 2;
    const a = store.putBlob("s1", Buffer.from("a"));
    const b = store.putBlob("s1", Buffer.from("b"));
    const c = store.putBlob("s1", Buffer.from("c"));
    store.append("s1", entry({ id: "e1", before: null, after: a }));
    store.append("s1", entry({ id: "e2", before: a, after: b }));
    store.append("s1", entry({ id: "e3", before: b, after: c }));

    store.evict("s1");

    const markers = store.readEntries("s1").filter((e) => e.op === "evicted");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.targetId).toBe("e1");
    expect(undoer.list({ sessionId: "s1", baseDir: root })).toHaveLength(2);
  });

  it("evicts down to the total-byte budget", () => {
    config.changes!.maxTotalBytes = 1;
    const a = store.putBlob("s1", Buffer.from("aaaa"));
    const b = store.putBlob("s1", Buffer.from("bbbb"));
    store.append("s1", entry({ id: "e1", before: null, after: a }));
    store.append("s1", entry({ id: "e2", before: a, after: b }));

    store.evict("s1");

    expect(undoer.list({ sessionId: "s1", baseDir: root })).toHaveLength(0);
    expect(() => store.getBlob("s1", a)).toThrow();
    expect(() => store.getBlob("s1", b)).toThrow();
  });

  it("keeps shared blobs and is idempotent", () => {
    config.changes!.maxRevisionsPerFile = 1;
    const a = store.putBlob("s1", Buffer.from("a"));
    const b = store.putBlob("s1", Buffer.from("b"));
    const c = store.putBlob("s1", Buffer.from("c"));
    store.append("s1", entry({ id: "e1", before: null, after: a }));
    store.append("s1", entry({ id: "e2", before: a, after: b }));
    store.append("s1", entry({ id: "e3", before: b, after: c }));

    store.evict("s1");

    expect(() => store.getBlob("s1", a)).toThrow();
    expect(() => store.getBlob("s1", b)).not.toThrow();
    expect(() => store.getBlob("s1", c)).not.toThrow();
    store.evict("s1");
    expect(
      store.readEntries("s1").filter((e) => e.op === "evicted"),
    ).toHaveLength(2);
  });

  it("never evicts an entry already targeted by an undo marker", () => {
    config.changes!.maxRevisionsPerFile = 1;
    const a = store.putBlob("s1", Buffer.from("a"));
    store.append("s1", entry({ id: "e1", before: null, after: a }));
    store.append("s1", entry({ id: "e2", before: a, after: null }));
    store.append(
      "s1",
      entry({ id: "u1", op: "undo", targetId: "e1", before: null, after: null }),
    );

    store.evict("s1");

    expect(
      store.readEntries("s1").filter((e) => e.op === "evicted"),
    ).toHaveLength(0);
  });

  it("resumes blob deletion after a failed delete without duplicating markers", () => {
    config.changes!.maxTotalBytes = 1;
    const a = store.putBlob("s1", Buffer.from("aaaa"));
    const b = store.putBlob("s1", Buffer.from("bbbb"));
    store.append("s1", entry({ id: "e1", before: null, after: a }));
    store.append("s1", entry({ id: "e2", before: a, after: b }));
    const blobA = join(store.dir("s1"), "blobs", a.slice(0, 2), `${a}.gz`);
    const blobB = join(store.dir("s1"), "blobs", b.slice(0, 2), `${b}.gz`);
    // A directory at a blob path makes rmSync fail; the other blob keeps the
    // byte budget exceeded so both entries are still victims.
    rmSync(blobA);
    mkdirSync(blobA);

    expect(() => store.evict("s1")).toThrow();
    expect(existsSync(blobA)).toBe(true);
    expect(existsSync(blobB)).toBe(false);
    expect(
      store.readEntries("s1").filter((e) => e.op === "evicted"),
    ).toHaveLength(2);

    rmSync(blobA, { recursive: true, force: true });
    store.evict("s1");
    expect(existsSync(blobA)).toBe(false);
    expect(
      store.readEntries("s1").filter((e) => e.op === "evicted"),
    ).toHaveLength(2);
  });
});
