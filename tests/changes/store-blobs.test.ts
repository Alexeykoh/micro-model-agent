import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  ChangesStore,
  changesConfig,
  createStore,
} from "./store-test-helpers";

let root: string;
let store: InstanceType<typeof ChangesStore>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-blobs-"));
  store = createStore(ChangesStore, root, changesConfig(root));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangesStore blob hashes", () => {
  it("rejects traversal-like and malformed non-null hashes", () => {
    const invalid = [
      "",
      "../outside",
      "..\\outside",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      `${"a".repeat(64)}/../outside`,
    ];
    for (const sha of invalid) {
      expect(() => store.getBlob("s1", sha)).toThrow(/invalid.*sha-256/i);
    }
  });

  it("returns null only when no blob hash is requested", () => {
    expect(store.getBlob("s1", null)).toBeNull();
  });

  it("stores a validated raw-content hash in its shard directory", () => {
    const sha = store.putBlob("s1", Buffer.from("hello"));
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
    const file = join(store.dir("s1"), "blobs", sha.slice(0, 2), `${sha}.gz`);
    expect(existsSync(file)).toBe(true);
    expect(dirname(file)).toBe(join(store.dir("s1"), "blobs", sha.slice(0, 2)));
  });
});

describe("ChangesStore blob integrity", () => {
  const blobFile = (sha: string): string =>
    join(store.dir("s1"), "blobs", sha.slice(0, 2), `${sha}.gz`);

  it("throws for a missing non-null blob", () => {
    expect(() => store.getBlob("s1", "b".repeat(64))).toThrow(/missing blob/i);
  });

  it("throws a descriptive error for a corrupt payload", () => {
    const sha = store.putBlob("s1", Buffer.from("hello"));
    writeFileSync(blobFile(sha), "not-a-gzip-payload", "utf8");
    expect(() => store.getBlob("s1", sha)).toThrow(/corrupt blob/i);
  });

  it("rejects decompressed content whose raw hash differs from its address", () => {
    const sha = store.putBlob("s1", Buffer.from("original"));
    writeFileSync(
      blobFile(sha),
      gzipSync(Buffer.from("tampered")).toString("base64"),
      "utf8",
    );
    expect(() => store.getBlob("s1", sha)).toThrow(/integrity|hash mismatch/i);
  });

  it("rejects oversized raw content on write using the per-file limit", () => {
    const config = changesConfig(root);
    config.changes!.maxFileBytes = 1024;
    config.changes!.maxTotalBytes = 8192;
    store = createStore(ChangesStore, root, config);
    expect(() => store.putBlob("s1", Buffer.alloc(4096, 1))).toThrow(
      /per-file|maxFileBytes|too large/i,
    );
  });

  it("bounds decompression by maxFileBytes even when maxTotalBytes is larger", () => {
    const config = changesConfig(root);
    config.changes!.maxFileBytes = 1024;
    config.changes!.maxTotalBytes = 8192;
    store = createStore(ChangesStore, root, config);
    const content = Buffer.alloc(4096, 1);
    const sha = createHash("sha256").update(content).digest("hex");
    const file = blobFile(sha);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, gzipSync(content).toString("base64"), "utf8");
    expect(() => store.getBlob("s1", sha)).toThrow(/blob.*(limit|large)/i);
  });

  it("rejects oversized encoded blobs before reading their payload", () => {
    const config = changesConfig(root);
    config.changes!.maxFileBytes = 1024;
    config.changes!.maxTotalBytes = 8192;
    store = createStore(ChangesStore, root, config);
    const sha = createHash("sha256").update("hello").digest("hex");
    const file = blobFile(sha);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x".repeat(1024 * 2 + 64 * 1024 + 1), "utf8");
    expect(() => store.getBlob("s1", sha)).toThrow(/encoded.*(large|limit)/i);
  });

  it("verifies and atomically repairs an existing corrupt blob", () => {
    const content = Buffer.from("hello");
    const sha = store.putBlob("s1", content);
    writeFileSync(blobFile(sha), "not-a-gzip-payload", "utf8");
    expect(() => store.getBlob("s1", sha)).toThrow(/corrupt blob/i);

    expect(store.putBlob("s1", content)).toBe(sha);
    expect(store.getBlob("s1", sha)!.equals(content)).toBe(true);
  });

  it("stores plaintext blobs as decodable gzip-base64 without temp files", () => {
    const sha = store.putBlob("s1", Buffer.from("hello"));
    const file = blobFile(sha);
    const raw = readFileSync(file, "utf8");
    expect(gunzipSync(Buffer.from(raw, "base64")).toString()).toBe("hello");
    expect(readdirSync(dirname(file)).some((name) => name.includes(".tmp"))).toBe(
      false,
    );
  });
});
