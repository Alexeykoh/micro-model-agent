import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { ChangesStore } from "../../src/modules/changes/store";
import type { ChangeEntry } from "../../src/modules/changes/types";

export { ChangesStore };

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
