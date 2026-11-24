import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { ChangesStore as ChangesStoreType } from "../../src/modules/changes/store";
import type { ChangeEntry } from "../../src/modules/changes/types";

// SessionFileEncryptor eagerly loads its default key at module import.
const { ChangesStore } = await (async () => {
  const configRoot = mkdtempSync(join(tmpdir(), "mma-changes-config-"));
  const previousConfigDir = process.env.MMA_CONFIG_DIR;
  try {
    process.env.MMA_CONFIG_DIR = configRoot;
    return await import("../../src/modules/changes/store");
  } finally {
    if (previousConfigDir === undefined) delete process.env.MMA_CONFIG_DIR;
    else process.env.MMA_CONFIG_DIR = previousConfigDir;
    rmSync(configRoot, { recursive: true, force: true });
  }
})();

let root: string;
let store: ChangesStoreType;
const config = structuredClone(DEFAULTS) as AppConfig;

const entry = (over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  v: 1,
  id: `ch_${Math.random().toString(36).slice(2)}`,
  ts: new Date().toISOString(),
  turn: 1,
  tool: "write_file",
  callId: "c1",
  op: "write",
  path: "a.txt",
  pathAbs: join(root, "a.txt"),
  before: null,
  after: "sha",
  bytes: 3,
  ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-"));
  config.security!.sessionEncryption.keyPath = join(
    root,
    ".session-encryption-key",
  );
  store = new ChangesStore({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ChangesStore", () => {
  it("appends entries and deduplicates blobs", () => {
    const a = store.putBlob("s1", Buffer.from("hello"));
    const b = store.putBlob("s1", Buffer.from("hello"));
    expect(a).toBe(b);
    expect(store.getBlob("s1", a)!.toString()).toBe("hello");
    store.append("s1", entry({ before: a, after: a }));
    expect(store.readEntries("s1")).toHaveLength(1);
    expect(store.readEntries("s1")[0]!.path).toBe("a.txt");
  });

  it("keeps a monotonic turn counter across recreated stores", () => {
    expect(store.nextTurn("s1")).toBe(1);
    expect(
      new ChangesStore({
        sessionManager: {
          getSessionDirectory: () => join(root, "sessions", "s1"),
        },
        getConfig: () => config,
      }).nextTurn("s1"),
    ).toBe(2);
  });

  it("skips broken journal lines and decrypts when encryption is on", () => {
    const dir = join(root, "sessions", "s1", "changes");
    store.append("s1", entry());
    const path = join(dir, "index.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}not-json\n`);
    expect(store.readEntries("s1")).toHaveLength(1);

    const enc = structuredClone(DEFAULTS) as AppConfig;
    enc.security!.sessionEncryption = {
      enabled: true,
      encryptHistory: true,
      encryptSessionLog: true,
      keyPath: join(root, ".session-encryption-key"),
    };
    const encrypted = new ChangesStore({
      sessionManager: {
        getSessionDirectory: () => join(root, "sessions", "s1"),
      },
      getConfig: () => enc,
    });
    encrypted.append("s1", entry({ id: "ch_enc", path: "b.txt" }));
    expect(encrypted.readEntries("s1").some((e) => e.id === "ch_enc")).toBe(
      true,
    );
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  });
});
