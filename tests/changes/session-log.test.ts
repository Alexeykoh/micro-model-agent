import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { createChangesPort } from "../../src/core/bootstrap/tool-context";
import { ChangesStore } from "../../src/modules/changes/store";
import type { SessionLogEntry } from "../../src/modules/session/log-types";
import type { SessionManager } from "../../src/modules/session/index";

interface Harness {
  root: string;
  config: AppConfig;
  logs: SessionLogEntry[];
  store: ChangesStore;
  sessionManager: SessionManager;
}

/**
 * Живой порт поверх поддельной сессии: ловим то, что реально пишется в лог.
 * Каст к `SessionManager` — тестовый шов: порт зовёт только
 * `getSessionDirectory` и `appendLog`, остальные методы не нужны.
 */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "mma-log-"));
  const config = structuredClone(DEFAULTS) as AppConfig;
  const logs: SessionLogEntry[] = [];
  const dir = (id: string) => join(root, "sessions", id);
  mkdirSync(dir("s1"), { recursive: true });
  const sessionManager = {
    getSessionDirectory: dir,
    appendLog: (entry: SessionLogEntry) => {
      logs.push(entry);
    },
  } as unknown as SessionManager;
  const store = new ChangesStore({
    sessionManager: { getSessionDirectory: dir },
    getConfig: () => config,
  });
  return { root, config, logs, store, sessionManager };
}

/** Одна записанная правка `a.txt`: before → after, файл на диске = after. */
function seedWrite(h: Harness, over: { before: string; after: string; id?: string }): void {
  const before = h.store.putBlob("s1", Buffer.from(over.before));
  const after = h.store.putBlob("s1", Buffer.from(over.after));
  writeFileSync(join(h.root, "a.txt"), over.after);
  h.store.append("s1", {
    v: 1,
    id: over.id ?? "e1",
    ts: new Date().toISOString(),
    turn: 1,
    tool: "write_file",
    callId: "c1",
    op: "write",
    path: "a.txt",
    pathAbs: join(h.root, "a.txt"),
    before,
    after,
    bytes: Buffer.byteLength(over.after),
  });
}

describe("change log events", () => {
  it("emits a typed change event with module:changes provenance on undo", () => {
    const h = harness();
    try {
      seedWrite(h, { before: "old", after: "new" });
      const port = createChangesPort(h.sessionManager, () => h.config);

      expect(port.undo({ sessionId: "s1", baseDir: h.root, path: "a.txt" }).ok).toBe(true);

      const changes = h.logs.filter((e) => e.type === "change");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        type: "change",
        source: "module:changes",
        module: "changes",
        operation: "changes.undo",
        path: "a.txt",
        op: "write",
        targetId: "e1",
        tool: "write_file",
      });
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("does not emit a change event when the undo is refused", () => {
    const h = harness();
    try {
      seedWrite(h, { before: "old", after: "new" });
      // Файл изменился после снапшота → откат отклонён, записи быть не должно.
      writeFileSync(join(h.root, "a.txt"), "hand-edited");
      const port = createChangesPort(h.sessionManager, () => h.config);

      expect(port.undo({ sessionId: "s1", baseDir: h.root, path: "a.txt" }).ok).toBe(false);
      expect(h.logs.filter((e) => e.type === "change")).toHaveLength(0);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
