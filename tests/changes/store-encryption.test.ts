import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  ChangesStore,
  changeEntry,
  changesConfig,
  createStore,
} from "./store-test-helpers";

let root: string;
let store: InstanceType<typeof ChangesStore>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-encryption-"));
  store = createStore(ChangesStore, root, changesConfig(root));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangesStore plaintext mode", () => {
  it("never initializes or requires an encryption key", () => {
    const config = changesConfig(root);
    const keyPath = join(root, "missing-key-directory", "session.key");
    config.security!.sessionEncryption = {
      enabled: false,
      encryptHistory: true,
      encryptSessionLog: true,
      keyPath,
    };
    store = createStore(ChangesStore, root, config);

    const sha = store.putBlob("s1", Buffer.from("hello"));
    expect(store.getBlob("s1", sha)!.toString()).toBe("hello");
    store.append("s1", changeEntry(root, { before: sha, after: sha }));
    expect(store.readEntries("s1")).toHaveLength(1);
    expect(store.nextTurn("s1")).toBe(2);
    expect(store.loadTurn("s1")).toBe(2);

    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(dirname(keyPath))).toBe(false);
    expect(readFileSync(join(store.dir("s1"), "index.jsonl"), "utf8")).toContain(
      "a.txt",
    );
    expect(readFileSync(join(store.dir("s1"), "state.json"), "utf8")).toContain(
      '"turn":2',
    );
  });
});

describe("ChangesStore encrypted mode", () => {
  const encryptedConfig = () => {
    const config = changesConfig(root);
    config.security!.sessionEncryption.enabled = true;
    return config;
  };
  const freshStore = () =>
    createStore(ChangesStore, root, encryptedConfig());
  const blobFile = (sha: string): string =>
    join(store.dir("s1"), "blobs", sha.slice(0, 2), `${sha}.gz`);

  beforeEach(() => {
    store = createStore(ChangesStore, root, encryptedConfig());
  });

  it("encrypts journal lines at rest and reads them through a fresh store", () => {
    store.append(
      "s1",
      changeEntry(root, { id: "ch_secret", path: "secret-marker.txt" }),
    );
    const raw = readFileSync(join(store.dir("s1"), "index.jsonl"), "utf8");
    expect(raw).not.toContain("secret-marker");
    expect(raw).not.toContain('"path"');

    const entries = freshStore().readEntries("s1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "ch_secret",
      path: "secret-marker.txt",
    });
  });

  it("encrypts blobs at rest and round-trips through a fresh store", () => {
    const content = Buffer.from("secret blob content");
    const sha = store.putBlob("s1", content);
    const raw = readFileSync(blobFile(sha), "utf8");
    expect(raw).not.toBe(gzipSync(content).toString("base64"));

    expect(freshStore().getBlob("s1", sha)!.equals(content)).toBe(true);
  });

  it("encrypts turn state at rest and resumes through a fresh store", () => {
    expect(store.nextTurn("s1")).toBe(1);
    const raw = readFileSync(join(store.dir("s1"), "state.json"), "utf8");
    expect(raw).not.toContain('"turn"');
    expect(raw).not.toContain('"v"');

    const fresh = freshStore();
    expect(fresh.loadTurn("s1")).toBe(1);
    expect(fresh.nextTurn("s1")).toBe(2);
  });
});
