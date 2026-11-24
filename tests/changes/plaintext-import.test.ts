import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dir, "../..");
const moduleUrl = (path: string): string =>
  pathToFileURL(join(repoRoot, path)).href;

let root: string;
let configDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-changes-import-"));
  configDir = join(root, "config");
  mkdirSync(configDir);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runIsolated(script: string) {
  return spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot,
    env: { ...process.env, MMA_CONFIG_DIR: configDir },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("encryption import isolation", () => {
  it("does not create a key when ChangesStore performs plaintext operations", () => {
    const script = `
      import { join } from "node:path";
      import { DEFAULTS } from ${JSON.stringify(moduleUrl("src/config/defaults.ts"))};
      import { ChangesStore } from ${JSON.stringify(moduleUrl("src/modules/changes/store.ts"))};
      const root = process.env.MMA_TEST_ROOT;
      const config = structuredClone(DEFAULTS);
      config.security.sessionEncryption.enabled = false;
      const store = new ChangesStore({
        sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
        getConfig: () => config,
      });
      const sha = store.putBlob("s1", Buffer.from("hello"));
      store.append("s1", {
        v: 1, id: "ch_plain", ts: new Date().toISOString(), turn: 1,
        tool: "write_file", callId: "c1", op: "write", path: "a.txt",
        pathAbs: join(root, "a.txt"), before: null, after: sha, bytes: 5,
      });
      store.nextTurn("s1");
      if (store.getBlob("s1", sha).toString() !== "hello") throw new Error("blob mismatch");
    `;
    const result = runIsolated(
      `process.env.MMA_TEST_ROOT = ${JSON.stringify(root)};\n${script}`,
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readdirSync(configDir)).toEqual([]);
    expect(existsSync(join(configDir, ".session-encryption-key"))).toBe(false);
    expect(existsSync(join(configDir, ".encryption-key"))).toBe(false);
  });

  it("initializes ConfigEncryptor's key only on first crypto use", () => {
    const keyPath = join(configDir, "lazy.key");
    const script = `
      import { ConfigEncryptor } from ${JSON.stringify(moduleUrl("src/modules/security/encryption.ts"))};
      const encryptor = new ConfigEncryptor({ keyPath: ${JSON.stringify(keyPath)} });
      if (await import("node:fs").then(({ existsSync }) => existsSync(${JSON.stringify(keyPath)}))) {
        throw new Error("key created during construction");
      }
      encryptor.getKey();
      const { existsSync } = await import("node:fs");
      if (!existsSync(${JSON.stringify(keyPath)})) throw new Error("key not created on getKey");
    `;
    const result = runIsolated(script);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails closed when turn recovery encounters an undecryptable journal line", () => {
    const script = `
      import { appendFileSync } from "node:fs";
      import { join } from "node:path";
      import { DEFAULTS } from ${JSON.stringify(moduleUrl("src/config/defaults.ts"))};
      import { ChangesStore } from ${JSON.stringify(moduleUrl("src/modules/changes/store.ts"))};
      const root = process.env.MMA_TEST_ROOT;
      const config = structuredClone(DEFAULTS);
      config.security.sessionEncryption = {
        enabled: true, encryptHistory: true, encryptSessionLog: true,
        keyPath: join(root, "session.key"),
      };
      const store = new ChangesStore({
        sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
        getConfig: () => config,
      });
      store.append("s1", {
        v: 1, id: "ch_valid", ts: new Date().toISOString(), turn: 3,
        tool: "write_file", callId: "c1", op: "write", path: "a.txt",
        pathAbs: join(root, "a.txt"), before: null, after: null, bytes: 0,
      });
      appendFileSync(join(store.dir("s1"), "index.jsonl"), "AAAA:AAAA:AAAA:AAAA\\n");
      let failed = false;
      try { store.nextTurn("s1"); } catch (error) {
        failed = /journal|decrypt/i.test(String(error));
      }
      if (!failed) throw new Error("recovery accepted an undecryptable journal");
    `;
    const result = runIsolated(
      `process.env.MMA_TEST_ROOT = ${JSON.stringify(root)};\n${script}`,
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("uses a replacement key at the same path for subsequent writes", () => {
    const script = `
      import { randomBytes } from "node:crypto";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { DEFAULTS } from ${JSON.stringify(moduleUrl("src/config/defaults.ts"))};
      import { ChangesStore } from ${JSON.stringify(moduleUrl("src/modules/changes/store.ts"))};
      const root = process.env.MMA_TEST_ROOT;
      const config = structuredClone(DEFAULTS);
      const keyPath = join(root, "rotating.key");
      config.security.sessionEncryption = {
        enabled: true, encryptHistory: true, encryptSessionLog: true, keyPath,
      };
      const makeEntry = (id, turn) => ({
        v: 1, id, ts: new Date().toISOString(), turn, tool: "write_file",
        callId: id, op: "write", path: id, pathAbs: join(root, id),
        before: null, after: null, bytes: 0,
      });
      const makeStore = () => new ChangesStore({
        sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
        getConfig: () => config,
      });
      writeFileSync(keyPath, randomBytes(32).toString("base64"), { mode: 0o600 });
      const store = makeStore();
      store.putBlob("s1", Buffer.from("first"));
      store.append("s1", makeEntry("ch_first", 1));
      writeFileSync(keyPath, randomBytes(32).toString("base64"), { mode: 0o600 });
      const secondSha = store.putBlob("s1", Buffer.from("second"));
      store.append("s1", makeEntry("ch_second", 2));
      const fresh = makeStore();
      if (fresh.getBlob("s1", secondSha).toString() !== "second") {
        throw new Error("replacement key did not encrypt the second blob");
      }
      const ids = fresh.readEntries("s1").map((entry) => entry.id);
      if (!ids.includes("ch_second") || ids.includes("ch_first")) {
        throw new Error("replacement key journal read mismatch");
      }
    `;
    const result = runIsolated(
      `process.env.MMA_TEST_ROOT = ${JSON.stringify(root)};\n${script}`,
    );

    expect(result.status).toBe(0);
  });

  it("uses the effective default key path for each operation", () => {
    const script = `
      import { existsSync, mkdirSync } from "node:fs";
      import { join } from "node:path";
      import { DEFAULTS } from ${JSON.stringify(moduleUrl("src/config/defaults.ts"))};
      import { ChangesStore } from ${JSON.stringify(moduleUrl("src/modules/changes/store.ts"))};
      const root = process.env.MMA_TEST_ROOT;
      const firstDir = join(root, "config-one");
      const secondDir = join(root, "config-two");
      mkdirSync(firstDir);
      mkdirSync(secondDir);
      const config = structuredClone(DEFAULTS);
      config.security.sessionEncryption = {
        enabled: true, encryptHistory: true, encryptSessionLog: true, keyPath: "",
      };
      const store = new ChangesStore({
        sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
        getConfig: () => config,
      });
      process.env.MMA_CONFIG_DIR = firstDir;
      store.putBlob("s1", Buffer.from("first"));
      process.env.MMA_CONFIG_DIR = secondDir;
      store.putBlob("s1", Buffer.from("second"));
      if (!existsSync(join(firstDir, ".session-encryption-key")) ||
          !existsSync(join(secondDir, ".session-encryption-key"))) {
        throw new Error("effective default key path was not respected");
      }
    `;
    const result = runIsolated(
      `process.env.MMA_TEST_ROOT = ${JSON.stringify(root)};\n${script}`,
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
