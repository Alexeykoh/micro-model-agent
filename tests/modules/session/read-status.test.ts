import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLogEntriesResult } from "../../../src/modules/session/log-file";
import { SessionStore } from "../../../src/modules/session/store";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-read-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Gate W3 (INV-15): «пусто» и «не прочитано» — разные состояния. Раньше
 * нечитаемый журнал/мета превращались в `[]`/`null` и выглядели как пустая
 * или удалённая сессия.
 */
describe("session read status", () => {
  it("различает отсутствующий, прочитанный и оборванный лог", () => {
    const dir = tempDir();
    expect(readLogEntriesResult(join(dir, "nope.jsonl")).status).toBe("missing");

    const log = join(dir, "session.jsonl");
    writeFileSync(log, '{"type":"user","source":"core"}\n');
    const ok = readLogEntriesResult(log);
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.value).toHaveLength(1);
      expect(ok.truncated).toBeFalsy();
    }

    writeFileSync(log, '{"type":"user","source":"core"}\n{"type":"assis');
    const truncated = readLogEntriesResult(log);
    expect(truncated.status).toBe("ok");
    if (truncated.status === "ok") expect(truncated.truncated).toBe(true);
  });

  it("нечитаемый путь даёт unreadable с причиной", () => {
    const dir = tempDir();
    const asDir = join(dir, "session.jsonl");
    mkdirSync(asDir);
    const result = readLogEntriesResult(asDir);
    expect(result.status).toBe("unreadable");
    if (result.status === "unreadable") expect(result.cause).toBeTruthy();
  });

  it("повреждённая meta.json не выглядит удалённой сессией", () => {
    const dir = tempDir();
    const id = "ses_broken";
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "meta.json"), "{not json");
    const store = new SessionStore(dir);
    const result = store.loadMetaWithStatus(id);
    expect(result.status).toBe("unreadable");
    expect(store.loadMetaWithStatus("ses_absent").status).toBe("missing");
  });

  it("session log через стор сохраняет статус", () => {
    const dir = tempDir();
    const id = "ses_ok";
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "session.jsonl"), '{"type":"user","source":"core"}\n');
    const store = new SessionStore(dir);
    const result = store.loadSessionLogWithStatus(id);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value).toHaveLength(1);
  });
});
