// OO-3/OO-8: durable леджер адресов, подключённый к ContextManager:
// адреса успешных тулов персистятся, блок компакции несёт указатель + legacy
// леджер тулов, фейл не попадает, успешная запись помечает источник stale,
// запись fail-open, `notesPath` содержится внутри baseDir.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContextManager } from "../../src/core/context/manager";
import { createContextManager } from "../../src/core/bootstrap/context-factory";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";

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
  it("records grep addresses at addMessage time (before compaction)", () => {
    const mgr = new ContextManager(32768);
    const notesPath = join(dir, "NOTES.md");
    mgr.configureLedger(notesPath, 200);

    seed(mgr, true); // только добавление сообщений, БЕЗ компакции

    // Адрес-находка записан из сырого результата сразу при входе в историю.
    expect(existsSync(notesPath)).toBe(true);
    expect(readFileSync(notesPath, "utf8")).toContain("corpus/hard-b.txt:3300");
  });

  it("renders the address list (not just a pointer) in the compaction block", () => {
    const mgr = new ContextManager(32768);
    const notesPath = join(dir, "NOTES.md");
    mgr.configureLedger(notesPath, 200);

    seed(mgr, true);
    const result = mgr.compact({ keepLastN: 2 });
    expect(result).toBeTruthy();
    expect(readFileSync(notesPath, "utf8")).toContain("corpus/hard-b.txt:3300");

    // Блок несёт сам адрес-находку (модель видит её без открытия файла) И указатель.
    const block = mgr.getCompactionBlock() ?? result!.summary;
    expect(block).toContain("corpus/hard-b.txt:3300");
    expect(block).toContain("[Notes:");
  });

  it("does not inline bulk raw tool content in the block", () => {
    const mgr = new ContextManager(32768);
    mgr.configureLedger(join(dir, "NOTES.md"), 200);
    const filler = "FILLER_".repeat(2000); // ~14K символов сырого вывода

    mgr.addMessage({ role: "user", content: "scan" });
    mgr.addMessage({
      role: "tool",
      name: "grep",
      content: `corpus/hard-c.txt:42:NEEDLE_C\n${filler}`,
      arguments: {},
      success: true,
    });
    for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `s${i}` });

    const block = mgr.compact({ keepLastN: 2 })!.summary;
    expect(block).toContain("corpus/hard-c.txt:42"); // адрес есть
    expect(block).not.toContain("FILLER_FILLER_FILLER_FILLER"); // сырьё — нет
  });

  it("renders both the notes pointer and the legacy tool ledger", () => {
    const mgr = new ContextManager(32768);
    mgr.configureLedger(join(dir, "NOTES.md"), 200);
    seed(mgr, true); // grep → адрес в леджер
    // Не-адресный тул: его анти-повтор обязан остаться в `[Tool ledger]`.
    mgr.addMessage({ role: "tool", name: "list_dir", content: "a\nb", arguments: { path: "." } });
    for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `x${i}` });

    const summary = mgr.compact({ keepLastN: 2 })!.summary;
    expect(summary).toContain("corpus/hard-b.txt:3300");
    expect(summary).toContain("[Notes:");
    expect(summary).toContain("[Tool ledger]");
    expect(summary).toContain("list_dir");
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

  it("degrades silently when the ledger file cannot be written (fail-open)", () => {
    // Файл-блокер на месте каталога леджера: mkdir/append обязаны упасть.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const mgr = new ContextManager(32768);
    mgr.configureLedger(join(blocker, "NOTES.md"), 200);
    seed(mgr, true);

    let result: ReturnType<typeof mgr.compact> = null;
    expect(() => {
      result = mgr.compact({ keepLastN: 2 });
    }).not.toThrow();
    expect(result).toBeTruthy();
  });

  it("clear() keeps the durable ledger but resets the in-memory tool ledger", () => {
    const mgr = new ContextManager(32768);
    const notesPath = join(dir, "NOTES.md");
    mgr.configureLedger(notesPath, 200);
    seed(mgr, true);
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();
    expect(readFileSync(notesPath, "utf8")).toContain("corpus/hard-b.txt:3300");

    mgr.clear();
    // Durable-файл не тронут.
    expect(readFileSync(notesPath, "utf8")).toContain("corpus/hard-b.txt:3300");

    // Новый ход: леджер тулов обнулён (только list_dir), указатель сохранён.
    mgr.addMessage({ role: "user", content: "again" });
    mgr.addMessage({ role: "tool", name: "list_dir", content: "a\nb", arguments: {} });
    for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `y${i}` });
    const summary = mgr.compact({ keepLastN: 2 })!.summary;
    expect(summary).toContain("[Notes:");
    expect(summary).toContain("[Tool ledger]");
    expect(summary).toContain("list_dir");
    expect(summary).not.toContain("grep");
  });

  it("contains a traversal notesPath inside baseDir/.mma", () => {
    const cfg = structuredClone(DEFAULTS) as AppConfig;
    cfg.contextBudget = { ...cfg.contextBudget, notesPath: "../../evil" };
    const mgr = createContextManager(cfg, dir);

    mgr.addMessage({ role: "user", content: "task" });
    mgr.addMessage({
      role: "tool",
      name: "grep",
      content: "corpus/hard-b.txt:3300:NEEDLE_B_222 marker",
      arguments: {},
      success: true,
    });
    for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `z${i}` });
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();

    const jailed = join(dir, ".mma", "NOTES.md");
    expect(existsSync(jailed)).toBe(true);
    expect(readFileSync(jailed, "utf8")).toContain("corpus/hard-b.txt:3300");
    // Выход за пределы песочницы не создан.
    expect(existsSync(resolve(dir, "../../evil"))).toBe(false);
  });
});
