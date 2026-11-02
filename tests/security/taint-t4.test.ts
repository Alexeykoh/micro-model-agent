/**
 * T4: taint переживает компакцию и resume; T5: диагностика `taint_degraded`.
 */
import { describe, expect, it } from "vitest";
import { ContextManager, type Message } from "../../src/core/context/manager";
import {
  FILE_CONTENT_MASK,
  tagFileContent,
} from "../../src/modules/security/data-policy/file-content";
import { admissionDiagnosticSink } from "../../src/core/bootstrap/tool-context";
import type { SessionManager } from "../../src/modules/session/manager";
import type { SessionLogEntry } from "../../src/modules/session/store";

function toolMsg(content: string): Message {
  return { role: "tool", content, tool_call_id: "c1" } as Message;
}

describe("T4: компакция", () => {
  it("сводка наследует taint выброшенного ввода и маскируется на внешнем egress", () => {
    const cm = new ContextManager(100_000);
    cm.beginTurn();
    cm.setEgressTrusted(true);
    cm.addMessage({ role: "user", content: "read the file" } as Message);
    cm.addMessage(toolMsg(tagFileContent("SECRET-CONTENT")));
    cm.addMessage({ role: "assistant", content: "derived SECRET-CONTENT" } as Message);
    for (let i = 0; i < 30; i++) {
      cm.addMessage({ role: "assistant", content: `step ${i}` } as Message);
    }

    cm.compactAdaptive({ keepLastN: 2 });

    const history = cm.getActiveHistory();
    const summary = history.find((m) => {
      const text = typeof m.content === "string" ? m.content : "";
      return text.startsWith("<system-summary>");
    });
    expect(summary).toBeDefined();
    expect(cm.isTainted(summary as Message)).toBe(true);
    // Внешний egress: сводка и оставшиеся записи не несут строку секрета.
    const out = JSON.stringify(cm.getHistoryForEgress(false));
    expect(out).not.toContain("SECRET-CONTENT");
    expect(out).toContain(FILE_CONTENT_MASK);
  });

  it("hard-drop помечает свою сводку, если выбросил tainted-записи", () => {
    const cm = new ContextManager(100_000);
    cm.beginTurn();
    cm.setEgressTrusted(true);
    cm.addMessage(toolMsg(tagFileContent("SECRET-CONTENT")));
    for (let i = 0; i < 40; i++) {
      cm.addMessage({ role: "assistant", content: `step ${i}` } as Message);
    }
    // Форсируем стадию hard-drop.
    (cm as unknown as { hardDropOldest: (keep: number) => unknown }).hardDropOldest(2);
    const summary = cm
      .getActiveHistory()
      .find((m) => typeof m.content === "string" && m.content.startsWith("<system-summary>"));
    expect(summary).toBeDefined();
    expect(cm.isTainted(summary as Message)).toBe(true);
  });
});

describe("T4: resume", () => {
  it("rehydrateTaint восстанавливает taint по sentinel'у и помечает производный ответ", () => {
    const cm = new ContextManager(100_000);
    cm.addMessage({ role: "user", content: "read it" } as Message);
    cm.addMessage(toolMsg(tagFileContent("SECRET-CONTENT")));
    cm.addMessage({ role: "assistant", content: "derived" } as Message);
    // Как после перезапуска: тaint ещё не известен (кроме сырого тула).
    expect(cm.taintedIndexes()).toEqual([false, true, false]);

    const count = cm.rehydrateTaint();
    expect(count).toBe(2);
    expect(cm.taintedIndexes()).toEqual([false, true, true]);
    // Производный ответ замаскирован здесь; тегированный tool-вывод — guard'ом.
    const history = cm.getHistoryForEgress(false);
    const assistant = history.find((m) => m.role === "assistant");
    expect(JSON.stringify(assistant)).not.toContain("SECRET-CONTENT");
    expect(JSON.stringify(assistant)).toContain(FILE_CONTENT_MASK);
  });

  it("чистая история не даёт taint", () => {
    const cm = new ContextManager(100_000);
    cm.addMessage({ role: "user", content: "hi" } as Message);
    cm.addMessage({ role: "assistant", content: "hello" } as Message);
    expect(cm.rehydrateTaint()).toBe(0);
  });
});

describe("T5: диагностика taint_degraded", () => {
  it("операция rehydrate пишется как taint_degraded", () => {
    const entries: SessionLogEntry[] = [];
    const sink = admissionDiagnosticSink({
      appendLog: (e: SessionLogEntry) => {
        entries.push(e);
      },
    } as unknown as SessionManager);
    sink({
      source: "core",
      operation: "taint.rehydrate",
      kind: "degraded",
      cause: "resume_heuristic: 2",
      recoverable: true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("taint_degraded");
    expect(entries[0].cause).toContain("resume_heuristic");
  });
});
