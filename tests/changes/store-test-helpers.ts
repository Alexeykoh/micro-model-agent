import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import type { ChangesStore as ChangesStoreType } from "../../src/modules/changes/store";
import type { ChangeEntry } from "../../src/modules/changes/types";

let storeModule: Promise<typeof import("../../src/modules/changes/store")> | undefined;

/** Load the store without letting its encryption import touch the real config dir. */
export function loadChangesStoreModule(): Promise<
  typeof import("../../src/modules/changes/store")
> {
  if (!storeModule) {
    const configRoot = mkdtempSync(join(tmpdir(), "mma-changes-config-"));
    const previousConfigDir = process.env.MMA_CONFIG_DIR;
    process.env.MMA_CONFIG_DIR = configRoot;
    storeModule = import("../../src/modules/changes/store").finally(() => {
      if (previousConfigDir === undefined) delete process.env.MMA_CONFIG_DIR;
      else process.env.MMA_CONFIG_DIR = previousConfigDir;
      rmSync(configRoot, { recursive: true, force: true });
    });
  }
  return storeModule;
}

export function changesConfig(root: string): AppConfig {
  const config = structuredClone(DEFAULTS) as AppConfig;
  config.security!.sessionEncryption.keyPath = join(
    root,
    ".session-encryption-key",
  );
  return config;
}

export function createStore(
  Store: typeof ChangesStoreType,
  root: string,
  config: AppConfig,
): ChangesStoreType {
  return new Store({
    sessionManager: { getSessionDirectory: () => join(root, "sessions", "s1") },
    getConfig: () => config,
  });
}

export function changeEntry(
  root: string,
  over: Partial<ChangeEntry> = {},
): ChangeEntry {
  return {
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
    after: "a".repeat(64),
    bytes: 3,
    ...over,
  };
}
