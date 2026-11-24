import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseChangeEntry,
  type ChangeEntry,
} from "../../src/modules/changes/types";
import {
  changeEntry,
  changesConfig,
  createStore,
  loadChangesStoreModule,
} from "./store-test-helpers";

const { ChangesStore } = await loadChangesStoreModule();

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
  it("accepts required and valid optional fields", () => {
    expect(parseChangeEntry(valid)).toEqual(valid);
    const withOptionals = changeEntry(root, {
      op: "move",
      mode: 0o600,
      to: "b.txt",
      toBefore: null,
      targetId: "ch_target",
      skipped: "evicted",
    });
    expect(parseChangeEntry(withOptionals)).toEqual(withOptionals);
  });

  it("rejects malformed shapes, unsafe numbers, and invalid optional fields", () => {
    const malformed: unknown[] = [
      null,
      [],
      {},
      { ...valid, v: 2 },
      { ...valid, id: "" },
      { ...valid, ts: "not-a-date" },
      { ...valid, turn: -1 },
      { ...valid, turn: 1.5 },
      { ...valid, turn: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, op: "rename" },
      { ...valid, path: 42 },
      { ...valid, pathAbs: null },
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
