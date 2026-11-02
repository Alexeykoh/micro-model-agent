/**
 * T1–T3: taint как свойство записи контекста, наследование производным ответом
 * на доверенной модели и маскирование на внешнем egress.
 */
import { describe, expect, it } from "vitest";
import { ContextManager, type Message } from "../../src/core/context/manager";
import {
  FILE_CONTENT_MASK,
  tagFileContent,
} from "../../src/modules/security/data-policy/file-content";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";

const CANARY = "CANARY7d2e91";

function manager(): ContextManager {
  return new ContextManager(100_000);
}

function toolMsg(content: string): Message {
  return { role: "tool", content, tool_call_id: "c1" } as Message;
}

function assistantMsg(content: string, withCall = false): Message {
  return {
    role: "assistant",
    content,
    ...(withCall
      ? {
          tool_calls: [
            {
              id: "c2",
              type: "function" as const,
              function: { name: "read_file", arguments: JSON.stringify({ path: "C:\\x" }) },
            },
          ],
        }
      : {}),
  } as Message;
}

describe("T1: taint помечается из тега file-content", () => {
  it("tool с sentinel'ом помечен, обычный tool и user — нет", () => {
    const cm = manager();
    cm.addMessage(toolMsg("plain output"));
    cm.addMessage(toolMsg(tagFileContent("protected")));
    cm.addMessage({ role: "user", content: "hello" } as Message);
    expect(cm.taintedIndexes()).toEqual([false, true, false]);
  });

  it("перенос флага на копию сообщения (repair) сохраняется по seq", () => {
    const cm = manager();
    cm.addMessage(toolMsg(tagFileContent("protected")));
    const copy = { ...cm.getActiveHistory()[0] };
    // Копия — другой объект, но seq у неё нет: флаг адресуется оригиналом.
    expect(cm.isTainted(cm.getActiveHistory()[0])).toBe(true);
    expect(cm.isTainted(copy)).toBe(false);
  });
});

describe("T2: производный ответ наследует taint только на доверенной модели", () => {
  it("доверенная цель: assistant после tainted-тула — tainted", () => {
    const cm = manager();
    cm.beginTurn();
    cm.setEgressTrusted(true);
    cm.addMessage(toolMsg(tagFileContent("protected")));
    cm.addMessage(assistantMsg("summary of protected"));
    expect(cm.taintedIndexes()).toEqual([true, true]);
  });

  it("внешняя цель: assistant не наследует (модель видела маску)", () => {
    const cm = manager();
    cm.beginTurn();
    cm.setEgressTrusted(false);
    cm.addMessage(toolMsg(tagFileContent("protected")));
    cm.addMessage(assistantMsg("summary without secrets"));
    expect(cm.taintedIndexes()).toEqual([true, false]);
  });

  it("новый ход сбрасывает наследование", () => {
    const cm = manager();
    cm.beginTurn();
    cm.setEgressTrusted(true);
    cm.addMessage(toolMsg(tagFileContent("protected")));
    cm.beginTurn();
    cm.addMessage(assistantMsg("next turn reasoning"));
    expect(cm.taintedIndexes()).toEqual([true, false]);
  });
});

describe("T3: внешний egress маскирует tainted-записи", () => {
  function tainted(): ContextManager {
    const cm = manager();
    cm.beginTurn();
    cm.setEgressTrusted(true);
    cm.addMessage(toolMsg(tagFileContent(`file body ${CANARY}`)));
    cm.addMessage(assistantMsg(`derived ${CANARY}`, true));
    return cm;
  }

  it("внешняя цель получает [FILE] вместо содержимого и аргументов", () => {
    const history = tainted().getHistoryForEgress(false);
    const text = JSON.stringify(history);
    expect(text).not.toContain(CANARY);
    expect(text).toContain(FILE_CONTENT_MASK);
    const call = history.find((m) => m.role === "assistant") as Message & {
      tool_calls: Array<{ function: { arguments: string } }>;
    };
    expect(call.tool_calls[0].function.arguments).toBe(FILE_CONTENT_MASK);
  });

  it("доверенная цель получает оригинал (локальная работа не деградирует)", () => {
    const text = JSON.stringify(tainted().getHistoryForEgress(true));
    expect(text).toContain(CANARY);
  });

  it("после маски guard не находит canary даже при fail-closed политике", () => {
    const ctx: PolicyContext = {
      baseDir: "C:\\work\\proj",
      home: "C:\\Users\\alex",
      hostname: "DESKTOP-ABC123",
      username: "alex",
      workspaceRoots: [],
    };
    const guard = createGuard({
      config: { ...DEFAULT_DATA_POLICY, pseudonymize: false },
      target: { kind: "provider", trusted: false, host: "api.example.com" },
      ctx,
    });
    const out = guard.sanitizeChat(tainted().getHistoryForEgress(false));
    expect(JSON.stringify(out)).not.toContain(CANARY);
  });
});
