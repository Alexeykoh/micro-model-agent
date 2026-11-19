import { beforeEach, describe, expect, it } from "vitest";
import { reportDlpRedactions } from "../../src/cli/context-bar";
import type { OutputChannel } from "../../src/output";
import type { SessionManager } from "../../src/modules/session/manager";
import {
  recordEgressTurn,
  resetEgressTurnJournal,
} from "../../src/modules/security/data-policy/turn-journal";
import type { GuardDiagnostic } from "../../src/modules/security/data-policy/types";

function output(): { channel: OutputChannel; lines: string[] } {
  const lines: string[] = [];
  const channel = {
    writeLine: (text: string) => lines.push(text),
  } as unknown as OutputChannel;
  return { channel, lines };
}

function sessions(id: string | undefined): SessionManager {
  return {
    getActiveMeta: () => (id ? { id } : null),
  } as unknown as SessionManager;
}

function redacted(sessionId: string): GuardDiagnostic {
  return {
    module: "security.data-policy",
    operation: "sanitizeChat",
    kind: "egress",
    outcome: "redacted",
    sessionId,
    target: { kind: "provider", trusted: false, host: "api.example.com" },
    tokens: [
      { dataClass: "path", kind: "windows-abs", token: "<PATH:abc>" },
      { dataClass: "secret", kind: "secret:key", token: "[SECRET]" },
    ],
  };
}

beforeEach(() => {
  resetEgressTurnJournal();
});

describe("CLI-строка о DLP-редакции", () => {
  it("печатает одну строку с количеством и классами", () => {
    recordEgressTurn(redacted("s1"));
    const { channel, lines } = output();
    reportDlpRedactions(channel, sessions("s1"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2");
    expect(lines[0]).toMatch(/DLP/i);
    // Оригиналов и token id в строке нет.
    expect(lines[0]).not.toContain("<PATH:abc>");
    expect(lines[0]).not.toContain("C:\\");
  });

  it("чистый ход молчит и не повторяет строку дважды", () => {
    recordEgressTurn(redacted("s1"));
    const { channel, lines } = output();
    reportDlpRedactions(channel, sessions("s1"));
    reportDlpRedactions(channel, sessions("s1"));
    expect(lines).toHaveLength(1);
  });

  it("без активной сессии ничего не печатает", () => {
    recordEgressTurn(redacted("s1"));
    const { channel, lines } = output();
    reportDlpRedactions(channel, sessions(undefined));
    expect(lines).toHaveLength(0);
  });
});
