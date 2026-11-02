import { beforeEach, describe, expect, it } from "vitest";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type {
  DataPolicyConfig,
  EgressHit,
  GuardDiagnostic,
} from "../../src/modules/security/data-policy/types";
import {
  beginEgressTurn,
  endEgressTurn,
  recordEgressTurn,
  resetEgressTurnJournal,
} from "../../src/modules/security/data-policy/turn-journal";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex", COMPUTERNAME: "DESKTOP-ABC123" },
  workspaceRoots: ["D:\\shared"],
};

const config: DataPolicyConfig = { ...DEFAULT_DATA_POLICY };
const target = { kind: "provider" as const, trusted: false, host: "api.openai.com" };

function guardHits(): EgressHit[] {
  const diags: GuardDiagnostic[] = [];
  const guard = createGuard({ config, target, ctx, onDiagnostic: (d) => diags.push(d) });
  guard.sanitizeChat(
    [
      { role: "system", content: "machine DESKTOP-ABC123" },
      { role: "user", content: "open C:\\work\\proj\\src\\a.ts now" },
    ],
    [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "reads C:\\work\\proj\\secret\\a.ts",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  );
  return diags.flatMap((d) => d.hits ?? []);
}

describe("позиционные находки DLP (U21)", () => {
  it("сообщение несёт роль, индекс, поле и диапазон", () => {
    const hit = guardHits().find((h) => h.dataClass === "path" && h.surface === "message");
    expect(hit).toBeDefined();
    expect(hit?.messageIdx).toBe(1);
    expect(hit?.role).toBe("user");
    expect(hit?.field).toBe("content");
    expect(hit?.start).toBeGreaterThanOrEqual(0);
    expect(hit?.end).toBeGreaterThan(hit?.start ?? 0);
  });

  it("находка в дефиниции тула несёт имя тула, а не индекс", () => {
    const hit = guardHits().find((h) => h.surface === "tool");
    expect(hit).toBeDefined();
    expect(hit?.tool).toBe("read_file");
    expect(hit?.field).toBe("description");
  });

  it("замена — метка маски, token id наружу не уходит", () => {
    for (const hit of guardHits()) {
      expect(hit.replacement).not.toContain("PATH:");
      expect(hit.replacement.length).toBeGreaterThan(0);
    }
  });

  it("находки не содержат оригинальных значений", () => {
    const text = JSON.stringify(guardHits());
    expect(text).not.toContain("C:\\work\\proj");
    expect(text).not.toContain("DESKTOP-ABC123");
  });
});

describe("журнал хода: кап позиций (U21)", () => {
  beforeEach(() => {
    resetEgressTurnJournal();
  });

  function redacted(hits: EgressHit[]): GuardDiagnostic {
    return {
      module: "security.data-policy",
      operation: "sanitizeChat",
      kind: "egress",
      outcome: "redacted",
      sessionId: "s1",
      target,
      hits,
    };
  }

  function hit(idx: number): EgressHit {
    return {
      dataClass: "path",
      kind: "windows-abs",
      surface: "message",
      messageIdx: idx,
      start: 0,
      end: 4,
      replacement: "[PATH]",
    };
  }

  it("дедуплицирует одинаковые места и капает 24", () => {
    beginEgressTurn("s1");
    recordEgressTurn(redacted(Array.from({ length: 30 }, (_, i) => hit(i))));
    recordEgressTurn(redacted([hit(0)]));
    const summary = endEgressTurn("s1");
    expect(summary?.hits).toHaveLength(24);
    expect(summary?.hitsTruncated).toBe(6);
  });

  it("пустой ход не отдаёт поля позиций", () => {
    beginEgressTurn("s1");
    recordEgressTurn(redacted([]));
    const summary = endEgressTurn("s1");
    expect(summary?.hits).toBeUndefined();
    expect(summary?.hitsTruncated).toBeUndefined();
  });
});
