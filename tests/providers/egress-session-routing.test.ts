import { afterEach, describe, expect, it } from "vitest";
import { createProviderEgressFactory } from "../../src/modules/security/data-policy/egress-provider";
import { setEgressDiagnosticSink } from "../../src/modules/security/data-policy/egress-provider";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { GuardDiagnostic } from "../../src/modules/security/data-policy/types";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";

const ctx: PolicyContext = { baseDir: "C:\\work\\proj", hostname: "DESKTOP-ABC123" };

afterEach(() => {
  setEgressDiagnosticSink(null);
});

describe("маршрутизация egress-диагностики по сессии", () => {
  it("sessionId из записи провайдера доходит до диагностики guard'а", () => {
    const diags: GuardDiagnostic[] = [];
    setEgressDiagnosticSink((d) => diags.push(d));
    const factory = createProviderEgressFactory({
      getConfig: () => ({ security: { dataPolicy: DEFAULT_DATA_POLICY } }) as never,
      ctx,
    });

    const guard = factory({
      type: "openai-compat",
      baseUrl: "https://api.openai.com/v1",
      sessionId: "sess-42",
    });
    expect(guard).toBeDefined();
    guard?.sanitizeChat([{ role: "user", content: "open C:\\work\\proj\\src\\a.ts" }]);

    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      sessionId: "sess-42",
      outcome: "redacted",
      target: { kind: "provider", trusted: false, host: "api.openai.com" },
    });
    expect(diags[0].tokens?.length).toBeGreaterThan(0);
    expect(diags[0].tokens?.every((t) => t.token.startsWith("<") || t.token.startsWith("["))).toBe(true);
  });

  it("без sessionId диагностика не получает чужую сессию", () => {
    const diags: GuardDiagnostic[] = [];
    setEgressDiagnosticSink((d) => diags.push(d));
    const factory = createProviderEgressFactory({
      getConfig: () => ({ security: { dataPolicy: DEFAULT_DATA_POLICY } }) as never,
      ctx,
    });

    factory({ type: "openai-compat", baseUrl: "https://api.openai.com/v1" })?.sanitizeChat([
      { role: "user", content: "open C:\\work\\proj\\src\\a.ts" },
    ]);

    expect(diags[0]?.sessionId).toBeUndefined();
  });
});
