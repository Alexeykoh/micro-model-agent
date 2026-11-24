import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../../src/modules/changes/store-fs";
import {
  ChangesStore,
  changeEntry,
  changesConfig,
  createStore,
} from "./store-test-helpers";

let root: string;
let store: InstanceType<typeof ChangesStore>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-"));
  store = createStore(ChangesStore, root, changesConfig(root));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangesStore", () => {
  it("cleans the unique temp file when atomic replacement fails", () => {
    const target = join(root, "existing-directory");
    mkdirSync(target);
    expect(() => writePrivateFileAtomic(target, "content")).toThrow();
    expect(readdirSync(root).some((name) => name.includes(".tmp"))).toBe(false);
  });

  it("appends entries and deduplicates blobs", () => {
    const sha = store.putBlob("s1", Buffer.from("hello"));
    expect(store.putBlob("s1", Buffer.from("hello"))).toBe(sha);
    expect(store.getBlob("s1", sha)!.toString()).toBe("hello");
    store.append("s1", changeEntry(root, { before: sha, after: sha }));
    expect(store.readEntries("s1")).toHaveLength(1);
    expect(store.readEntries("s1")[0]!.path).toBe("a.txt");
  });

  it("keeps a monotonic turn counter across recreated stores", () => {
    expect(store.nextTurn("s1")).toBe(1);
    const recreated = createStore(ChangesStore, root, changesConfig(root));
    expect(recreated.nextTurn("s1")).toBe(2);
  });

  it("skips broken plaintext journal lines", () => {
    store.append("s1", changeEntry(root));
    const index = join(store.dir("s1"), "index.jsonl");
    appendFileSync(index, "not-json\n", "utf8");
    expect(store.readEntries("s1")).toHaveLength(1);
    expect(readFileSync(index, "utf8")).toContain("a.txt");
  });

  it.skipIf(process.platform === "win32")("uses private directory and file permissions", () => {
    const sha = store.putBlob("s1", Buffer.from("hello"));
    store.append("s1", changeEntry(root, { before: sha, after: sha }));
    const index = join(store.dir("s1"), "index.jsonl");
    chmodSync(index, 0o644);
    store.append("s1", changeEntry(root, { id: "ch_second" }));
    store.nextTurn("s1");
    const blob = join(
      store.dir("s1"),
      "blobs",
      sha.slice(0, 2),
      `${sha}.gz`,
    );
    for (const dir of [
      store.dir("s1"),
      join(store.dir("s1"), "blobs"),
      join(store.dir("s1"), "blobs", sha.slice(0, 2)),
    ]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    for (const file of [
      join(store.dir("s1"), "index.jsonl"),
      join(store.dir("s1"), "state.json"),
      blob,
    ]) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
