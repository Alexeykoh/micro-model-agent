import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseChangeEntry,
  type ChangeEntry,
} from "../../src/modules/changes/types";
import {
  ChangesStore,
  changeEntry,
  changesConfig,
  createStore,
} from "./store-test-helpers";

let root: string;
let store: InstanceType<typeof ChangesStore>;
let valid: ChangeEntry;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-validation-"));
  store = createStore(ChangesStore, root, changesConfig(root));
  valid = changeEntry(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseChangeEntry", () => {
  it("accepts required and operation-specific optional fields", () => {
    expect(parseChangeEntry(valid)).toEqual(valid);
    const move = changeEntry(root, {
      op: "move",
      mode: 0o600,
      to: "b.txt",
      toBefore: null,
    });
    expect(parseChangeEntry(move)).toEqual(move);
    const undo = changeEntry(root, { op: "undo", targetId: "ch_target" });
    expect(parseChangeEntry(undo)).toEqual(undo);
    const evicted = changeEntry(root, {
      op: "evicted",
      targetId: "ch_target",
      skipped: "evicted",
    });
    expect(parseChangeEntry(evicted)).toEqual(evicted);
  });

  it("rejects malformed shapes, unsafe numbers, and invalid optional fields", () => {
    const malformed: unknown[] = [
      null,
      [],
      {},
      { ...valid, v: 2 },
      { ...valid, id: "" },
      { ...valid, ts: "not-a-date" },
      { ...valid, turn: 0 },
      { ...valid, turn: -1 },
      { ...valid, turn: 1.5 },
      { ...valid, turn: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, op: "rename" },
      { ...valid, path: 42 },
      { ...valid, pathAbs: null },
      { ...valid, pathAbs: "relative.txt" },
      { ...valid, before: "sha" },
      { ...valid, after: "A".repeat(64) },
      { ...valid, bytes: -1 },
      { ...valid, bytes: "3" },
      { ...valid, mode: "600" },
      { ...valid, mode: -1 },
      { ...valid, to: 7 },
      { ...valid, toBefore: "../bad" },
      { ...valid, targetId: null },
      { ...valid, skipped: "other" },
      { ...valid, op: "move" },
      { ...valid, op: "move", to: "b.txt", toBefore: "bad" },
      { ...valid, op: "move", to: "b.txt", targetId: "ch_target" },
      { ...valid, to: "b.txt" },
      { ...valid, toBefore: null },
      { ...valid, targetId: "ch_target" },
      { ...valid, op: "delete", to: "b.txt" },
      { ...valid, op: "undo" },
      { ...valid, op: "undo", targetId: "" },
      { ...valid, op: "undo", targetId: "ch_target", to: "b.txt" },
      { ...valid, op: "undo", targetId: "ch_target", toBefore: null },
      { ...valid, op: "evicted" },
      { ...valid, op: "evicted", targetId: "" },
      { ...valid, op: "evicted", targetId: "ch_target", to: "b.txt" },
      { ...valid, skipped: "evicted" },
      { ...valid, op: "move", to: "b.txt", skipped: "evicted" },
      { ...valid, op: "undo", targetId: "ch_target", skipped: "evicted" },
    ];
    for (const value of malformed) {
      expect(parseChangeEntry(value)).toBeNull();
    }
  });
});

describe("ChangesStore journal validation", () => {
  it("skips syntactically valid but malformed journal objects", () => {
    const keep = changeEntry(root, { id: "ch_keep" });
    store.append("s1", keep);
    const malformed = [
      { ...valid, id: "ch_bad_shape", path: null },
      { ...valid, id: "ch_bad_op", op: "rename" },
      { ...valid, id: "ch_bad_turn", turn: -1 },
      { ...valid, id: "ch_bad_mode", mode: "600" },
      { ...valid, id: "ch_bad_hash", before: "../bad" },
    ];
    const index = join(store.dir("s1"), "index.jsonl");
    appendFileSync(
      index,
      `${malformed.map((value) => JSON.stringify(value)).join("\n")}\n`,
      "utf8",
    );

    expect(store.readEntries("s1").map((value) => value.id)).toEqual([
      "ch_keep",
    ]);
  });
});
