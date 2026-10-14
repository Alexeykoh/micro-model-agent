// INV-15: детектор «компакция без прогресса». Серия компакций, не прибавивших
// ни одного нового адреса в durable-леджер, обязана дать различимый сигнал
// (`no-progress` → `context_degraded`). Рост леджера серию сбрасывает.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../../src/core/context/manager";
import { contextDegradedSink } from "../../src/core/bootstrap/context-factory";
import type { ProgressDiagnostic } from "../../src/core/context/compaction-progress";
import type { SessionManager } from "../../src/modules/session/index";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compaction-progress-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Ход без адресных находок: только пользователь + assistant-сообщения. */
function plainTurn(mgr: ContextManager, tag: string): void {
  mgr.addMessage({ role: "user", content: `задача ${tag}` });
  for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `step ${tag} ${i}` });
}

/** Ход с адресной находкой grep — новый `path:line` попадает в леджер. */
function findingTurn(mgr: ContextManager, path: string, line: number): void {
  mgr.addMessage({ role: "user", content: `найди ${path}` });
  mgr.addMessage({
    role: "tool",
    name: "grep",
    content: `${path}:${line}:NEEDLE marker`,
    arguments: { pattern: "NEEDLE" },
    success: true,
  });
  for (let i = 0; i < 20; i++) mgr.addMessage({ role: "assistant", content: `step ${i}` });
}

describe("compaction without progress detector (INV-15)", () => {
  it("fires no-progress after two compactions that add no ledger addresses", () => {
    const mgr = new ContextManager(32768);
    mgr.configureLedger(join(dir, "NOTES.md"), 200);
    const seen: ProgressDiagnostic[] = [];
    mgr.setProgressDiagnosticSink((d) => seen.push(d));

    plainTurn(mgr, "a");
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();
    // Первая компакция лишь начинает серию — сигнала ещё нет.
    expect(seen).toHaveLength(0);

    plainTurn(mgr, "b");
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();
    expect(seen.map((d) => d.kind)).toContain("no-progress");
    expect(seen[0]).toMatchObject({ kind: "no-progress", compactions: 2 });
  });

  it("does not fire when every compaction adds new ledger addresses", () => {
    const mgr = new ContextManager(32768);
    mgr.configureLedger(join(dir, "NOTES.md"), 200);
    const seen: ProgressDiagnostic[] = [];
    mgr.setProgressDiagnosticSink((d) => seen.push(d));

    findingTurn(mgr, "src/a.ts", 10);
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();
    findingTurn(mgr, "src/b.ts", 20);
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();
    findingTurn(mgr, "src/c.ts", 30);
    expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();

    expect(seen).toEqual([]);
  });

  it("emits again after a fresh no-progress streak (reset after firing)", () => {
    const mgr = new ContextManager(32768);
    mgr.configureLedger(join(dir, "NOTES.md"), 200);
    const seen: ProgressDiagnostic[] = [];
    mgr.setProgressDiagnosticSink((d) => seen.push(d));

    for (let round = 0; round < 4; round++) {
      plainTurn(mgr, `r${round}`);
      expect(mgr.compact({ keepLastN: 2 })).toBeTruthy();
    }
    // Серия сбрасывается после эмита: 4 компакции без прогресса — 2 сигнала.
    expect(seen.map((d) => d.kind)).toEqual(["no-progress", "no-progress"]);
  });

  it("writes a context_degraded session diagnostic via the wired sink", () => {
    const entries: Array<Record<string, unknown>> = [];
    const fake = {
      appendLog: (e: Record<string, unknown>) => {
        entries.push(e);
      },
    } as unknown as SessionManager;

    contextDegradedSink(fake)({ kind: "no-progress", compactions: 2 });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "context_degraded",
      source: "core",
      errorKind: "degraded",
      recoverable: true,
    });
    expect(String(entries[0].cause)).toContain("2");
  });
});
