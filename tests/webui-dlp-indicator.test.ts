import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../src/modules/session/index";
import type { SessionLogEntry } from "../src/modules/session/store";
import type { SseEvent } from "../src/modules/webui/state";
import { normalizeHistory } from "../src/modules/webui/session/history-api";
import { attachEgressTurn } from "../src/modules/webui/session/egress-turn";
import {
  beginEgressTurn,
  recordEgressTurn,
  resetEgressTurnJournal,
} from "../src/modules/security/data-policy/turn-journal";
import type { EgressTurnSummary, GuardDiagnostic } from "../src/modules/security/data-policy/types";

const summary: EgressTurnSummary = {
  total: 1,
  stats: { path: 1 },
  kinds: { path: ["windows-abs"] },
  targets: [{ kind: "provider", trusted: false, host: "api.openai.com" }],
};

function manager(): { manager: SessionManager; appendLog: ReturnType<typeof vi.fn> } {
  const appendLog = vi.fn();
  return { manager: { appendLog } as unknown as SessionManager, appendLog };
}

function diag(sessionId: string): GuardDiagnostic {
  return {
    module: "security.data-policy",
    operation: "sanitizeChat",
    kind: "egress",
    outcome: "redacted",
    sessionId,
    target: { kind: "provider", trusted: false, host: "api.openai.com" },
    tokens: [{ dataClass: "path", kind: "windows-abs", token: "<PATH:abc>" }],
  };
}

beforeEach(() => {
  resetEgressTurnJournal();
});

describe("egress в конце хода", () => {
  it("на turn_end персистит egress_turn и добавляет egress в SSE", () => {
    const { manager: m, appendLog } = manager();
    beginEgressTurn("s1");
    recordEgressTurn(diag("s1"));

    const out = attachEgressTurn(m, "s1", { type: "turn_end", ts: 1, success: true });

    expect(out.egress).toMatchObject({ total: 1, stats: { path: 1 } });
    expect(appendLog).toHaveBeenCalledTimes(1);
    expect(appendLog.mock.calls[0][0]).toMatchObject({
      type: "egress_turn",
      source: "module:security.data-policy",
      module: "security.data-policy",
      egress: { total: 1 },
    });
  });

  it("чистый ход тоже даёт событие с total 0", () => {
    const { manager: m, appendLog } = manager();
    beginEgressTurn("s1");

    const out = attachEgressTurn(m, "s1", { type: "turn_end", ts: 1 });

    expect(out.egress).toMatchObject({ total: 0 });
    expect(appendLog).toHaveBeenCalledTimes(1);
  });

  it("политика выключена (журнал не открыт) — события и персиста нет", () => {
    const { manager: m, appendLog } = manager();

    const out = attachEgressTurn(m, "s1", { type: "turn_end", ts: 1 });

    expect(out.egress).toBeUndefined();
    expect(appendLog).not.toHaveBeenCalled();
  });

  it("не-turn_end проходит без изменений", () => {
    const { manager: m, appendLog } = manager();
    beginEgressTurn("s1");
    const ev: SseEvent = { type: "token", ts: 1, text: "x" };

    expect(attachEgressTurn(m, "s1", ev)).toBe(ev);
    expect(appendLog).not.toHaveBeenCalled();
  });

  it("фейл персиста не роняет ход (fail-open)", () => {
    const appendLog = vi.fn(() => {
      throw new Error("disk full");
    });
    const m = { appendLog } as unknown as SessionManager;
    beginEgressTurn("s1");

    expect(() => attachEgressTurn(m, "s1", { type: "turn_end", ts: 1 })).not.toThrow();
  });
});

describe("история DLP", () => {
  it("egress_turn маппится в kind=egress и переживает replay", () => {
    const entries: SessionLogEntry[] = [
      { ts: "2026-10-20T10:00:00.000Z", type: "egress_turn", source: "module:security.data-policy", egress: summary },
    ];

    expect(normalizeHistory(entries, 0)).toEqual([
      { ts: "2026-10-20T10:00:00.000Z", kind: "egress", egress: summary },
    ]);
  });

  it("egress_turn без агрегата не рендерится", () => {
    const entries: SessionLogEntry[] = [
      { ts: "2026-10-20T10:00:00.000Z", type: "egress_turn", source: "module:security.data-policy" },
    ];
    expect(normalizeHistory(entries, 0)).toEqual([]);
  });
});

