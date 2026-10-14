// OO-3/OO-8: durable леджер адресов, подключённый к ContextManager:
// адреса успешных тулов персистятся, блок компакции несёт только указатель,
// фейл не попадает, успешная запись помечает источник stale.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../src/core/context/manager";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-manager-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Сообщения с одним grep-результатом, залитые ассистентскими ходами. */
function seed(mgr: ContextManager, success: boolean): void {
  mgr.addMessage({ role: "user", content: "найди иголку" });
  mgr.addMessage({
    role: "tool",
    name: "grep",
    content: "corpus/hard-b.txt:3300:NEEDLE_B_222 marker",
    arguments: { pattern: "NEEDLE_B_222" },
    success,
  });
  for (let i = 0; i < 20; i++) {
    mgr.addMessage({ role: "assistant", content: `step ${i}` });
  }
}

describe("ContextManager durable ledger", () => {
  it("persists grep addresses to NOTES.md and pins only a pointer", () => {
    const mgr = new ContextManager(32768);
    const notesPath = join(dir, "NOTES.md");
    mgr.configureLedger(notesPath, 200);

    seed(mgr, true);
    const result = mgr.compact({ keepLastN: 2 });
    expect(result).toBeTruthy();

    // Адрес-находка durable: файл создан и содержит `path:line`.
    expect(existsSync(notesPath)).toBe(true);
    expect(readFileSync(notesPath, "utf8")).toContain("corpus/hard-b.txt:3300");

    // Блок компакции несёт указатель, а не сырые заметки.
    const block = mgr.getCompactionBlock() ?? result!.summary;
    expect(block).toContain("[Notes:");
    expect(block).not.toContain("NEEDLE_B_222");
  });

  it("does not record failed tool results", () => {
    const mgr = new ContextManager(32768);
    const notesPath = join(dir, "NOTES.md");
    mgr.configureLedger(notesPath, 200);

    seed(mgr, false);
    const result = mgr.compact({ keepLastN: 2 });
    expect(result).toBeTruthy();

    expect(result!.summary).not.toContain("[Notes:");
    if (existsSync(notesPath)) {
      expect(readFileSync(notesPath, "utf8")).not.toContain("corpus/hard-b.txt:3300");
    }
  });

  it("marks an entry stale after a successful write to that file", () => {
    const mgr = new ContextManager(32768);
    const notesPath = join(dir, "NOTES.md");
    mgr.configureLedger(notesPath, 200);

    seed(mgr, true);
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();

    // OO-8: успешная правка изменённого файла помечает его адреса stale.
    mgr.addMessage({
      role: "tool",
      name: "write_file",
      content: "written",
      arguments: { path: "corpus/hard-b.txt" },
      success: true,
    });

    const notes = readFileSync(notesPath, "utf8");
    expect(notes).toMatch(/corpus\/hard-b\.txt:3300 — .*\(stale\)/);
  });
});
