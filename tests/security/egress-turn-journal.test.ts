import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardDiagnostic } from "../../src/modules/security/data-policy/types";
import {
  beginEgressTurn,
  endEgressTurn,
  noteEgressTarget,
  recordEgressTurn,
  resetEgressTurnJournal,
} from "../../src/modules/security/data-policy/turn-journal";
import { egressDiagnosticSink } from "../../src/core/bootstrap/tool-context";
import type { SessionManager } from "../../src/modules/session/index";

const providerTarget = { kind: "provider" as const, trusted: false, host: "api.openai.com" };

function redacted(
  sessionId: string,
  tokens: GuardDiagnostic["tokens"],
  target = providerTarget,
): GuardDiagnostic {
  return {
    module: "security.data-policy",
    operation: "sanitizeChat",
    kind: "egress",
    outcome: "redacted",
    sessionId,
    target,
    tokens,
  };
}

const pathToken = (id: string) => ({ dataClass: "path" as const, kind: "windows-abs", token: `<PATH:${id}>` });

beforeEach(() => {
  resetEgressTurnJournal();
});

describe("журнал DLP за ход", () => {
  it("дедуплицирует токенизированные значения по token id", () => {
    beginEgressTurn("s1");
    recordEgressTurn(redacted("s1", [pathToken("a"), pathToken("a")]));
    recordEgressTurn(redacted("s1", [pathToken("a"), pathToken("b")]));

    const summary = endEgressTurn("s1");
    expect(summary).toMatchObject({ total: 2, stats: { path: 2 }, kinds: { path: ["windows-abs"] } });
    expect(summary?.targets).toEqual([providerTarget]);
  });

  it("секреты без id считает max per kind за вызов, а не суммой вызовов", () => {
    beginEgressTurn("s1");
    const secret = (n: number, kind: string): GuardDiagnostic["tokens"] =>
      Array.from({ length: n }, () => ({ dataClass: "secret" as const, kind, token: "[SECRET]" }));
    // title-gen дублирует те же два секрета основного вызова
    recordEgressTurn(redacted("s1", [...secret(2, "api-key"), ...secret(1, "password")]));
    recordEgressTurn(redacted("s1", [...secret(2, "api-key"), ...secret(1, "password")]));

    const summary = endEgressTurn("s1");
    expect(summary?.stats.secret).toBe(3);
    // Наружу — только безопасная метка: id паттернов (`secret:0`) E2-редактор
    // webui принимает за секрет и переписывает в истории.
    expect(summary?.kinds.secret).toEqual(["secret"]);
  });

  it("внутренние id секретов не утекают в агрегат", () => {
    beginEgressTurn("s1");
    recordEgressTurn(redacted("s1", [{ dataClass: "secret", kind: "secret:0", token: "[SECRET]" }]));
    recordEgressTurn(redacted("s1", [{ dataClass: "secret", kind: "secret:2", token: "[SECRET]" }]));

    const summary = endEgressTurn("s1");
    expect(summary?.total).toBe(2);
    expect(JSON.stringify(summary?.kinds)).not.toContain("secret:");
  });

  it("виды одного класса суммируются по max каждого вида", () => {
    beginEgressTurn("s1");
    recordEgressTurn(redacted("s1", [{ dataClass: "secret", kind: "api-key", token: "[SECRET]" }]));
    recordEgressTurn(redacted("s1", [{ dataClass: "secret", kind: "password", token: "[SECRET]" }]));

    expect(endEgressTurn("s1")?.total).toBe(2);
  });

  it("чистый ход возвращает total 0 и известное назначение", () => {
    noteEgressTarget("s1", { kind: "provider", trusted: true, host: "localhost" });
    beginEgressTurn("s1");

    const summary = endEgressTurn("s1");
    expect(summary).toEqual({
      total: 0,
      stats: {},
      kinds: {},
      targets: [{ kind: "provider", trusted: true, host: "localhost" }],
    });
  });

  it("без begin ход не открыт — диагностика игнорируется", () => {
    recordEgressTurn(redacted("s1", [pathToken("a")]));
    expect(endEgressTurn("s1")).toBeUndefined();
  });

  it("ход без журнала не даёт агрегата (политика выключена)", () => {
    expect(endEgressTurn("s1")).toBeUndefined();
  });

  it("E2-фильтрация webui (target.kind=api) не считается", () => {
    beginEgressTurn("s1");
    recordEgressTurn(redacted("s1", [pathToken("a")], { kind: "api", trusted: false }));
    expect(endEgressTurn("s1")?.total).toBe(0);
  });

  it("не-redacted и чужая сессия не смешиваются", () => {
    beginEgressTurn("s1");
    beginEgressTurn("s2");
    recordEgressTurn({ ...redacted("s1", [pathToken("a")]), outcome: "aborted" });
    recordEgressTurn(redacted("s2", [pathToken("b")]));

    expect(endEgressTurn("s1")?.total).toBe(0);
    expect(endEgressTurn("s2")?.total).toBe(1);
  });

  it("повторный begin отбрасывает незакрытый бакет", () => {
    beginEgressTurn("s1");
    recordEgressTurn(redacted("s1", [pathToken("a")]));
    beginEgressTurn("s1");
    expect(endEgressTurn("s1")?.total).toBe(0);
  });

  it("production sink пишет redacted в журнал и не засоряет session.jsonl", () => {
    const manager = { appendLog: vi.fn() } as unknown as SessionManager;
    const sink = egressDiagnosticSink(manager);
    beginEgressTurn("s1");

    sink(redacted("s1", [pathToken("a")]));

    expect(manager.appendLog).not.toHaveBeenCalled();
    expect(endEgressTurn("s1")?.total).toBe(1);
  });
});
