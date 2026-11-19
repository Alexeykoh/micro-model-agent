import { describe, expect, it } from "vitest";
import { classify } from "../../src/modules/security/data-policy/classify";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex" },
  workspaceRoots: [],
};

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

describe("base64-обёртка известного значения (encoded-value-bypass)", () => {
  it("находит путь, спрятанный в base64", () => {
    const blob = b64("C:\\work\\proj\\src\\a.ts");
    const found = classify(`see ${blob} now`, ctx);
    const hit = found.find((f) => f.kind === "encoded-path");
    expect(hit).toBeDefined();
    expect(hit?.dataClass).toBe("path");
    expect(`see ${blob} now`.slice(hit?.start, hit?.end)).toBe(blob);
  });

  it("находит секрет, спрятанный в base64", () => {
    const blob = b64("api_key=sk-abcdefghij0123456789");
    const found = classify(`token ${blob}`, ctx);
    expect(found.some((f) => f.kind === "encoded-secret")).toBe(true);
  });

  it("обычная base64-строка без известных значений не ловится", () => {
    const blob = b64("hello world, nothing sensitive here at all");
    const found = classify(`text ${blob}`, ctx);
    expect(found.some((f) => f.kind.startsWith("encoded-"))).toBe(false);
  });

  it("проекция маскирует base64-блок целиком", () => {
    const blob = b64("C:\\work\\proj\\src\\a.ts");
    const guard = createGuard({
      config: { ...DEFAULT_DATA_POLICY, pseudonymize: false },
      target: { kind: "provider", trusted: false, host: "api.example.com" },
      ctx,
    });
    const out = guard.sanitizeChat([{ role: "user", content: `see ${blob} now` }]);
    const text = String((out.messages[0] as { content: string }).content);
    expect(text).not.toContain(blob);
    expect(text).toContain("[PATH]");
  });
});
