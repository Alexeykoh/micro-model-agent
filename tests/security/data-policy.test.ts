import { describe, it, expect } from "vitest";
import { classify } from "../../src/modules/security/data-policy/classify";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex", COMPUTERNAME: "DESKTOP-ABC123" },
  workspaceRoots: ["D:\\shared"],
};

const cfg: DataPolicyConfig = { ...DEFAULT_DATA_POLICY };

describe("classify", () => {
  it("находит value-based путь, hostname и секрет", () => {
    const text = "open C:\\work\\proj\\src\\a.ts on DESKTOP-ABC123 with api_key=sk-abcdefghij0123456789";
    const kinds = classify(text, ctx).map((f) => f.kind);
    expect(kinds).toContain("value");
    expect(kinds).toContain("hostname");
    expect(kinds.some((k) => k.startsWith("secret:"))).toBe(true);
  });

  it("URL не трактуется как POSIX-путь (Q9)", () => {
    const text = "see https://example.com/home/user/data for details";
    const paths = classify(text, ctx).filter((f) => f.dataClass === "path");
    expect(paths).toHaveLength(0);
  });

  it("регистр и разделители не влияют (INV-D8)", () => {
    const text = "C:/WORK/PROJ\\SRC\\A.TS";
    const found = classify(text, ctx).filter((f) => f.dataClass === "path");
    expect(found.length).toBeGreaterThan(0);
  });

  it("находки не перекрываются", () => {
    const text = "C:\\work\\proj и DESKTOP-ABC123 и 7707083893";
    const found = classify(text, ctx);
    for (let i = 1; i < found.length; i++) {
      expect(found[i].start).toBeGreaterThanOrEqual(found[i - 1].end);
    }
  });

  it("бюджет времени: 4000 символов < 200мс", () => {
    const text = ("line with C:\\work\\proj\\x and +7 (912) 345-67-89\n").repeat(100);
    const t0 = performance.now();
    classify(text, ctx);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("EgressGuard.sanitizeChat", () => {
  const external = () =>
    createGuard({ config: cfg, target: { kind: "provider", trusted: false, host: "api.openai.com" }, ctx });
  const local = () =>
    createGuard({ config: cfg, target: { kind: "provider", trusted: true, host: "localhost" }, ctx });

  it("внешнему: baseDir/hostname не уходят", () => {
    const g = external();
    const r = g.sanitizeChat([
      { role: "system", content: "Workspace: C:\\work\\proj. CWD: C:\\work\\proj" },
      { role: "user", content: "host DESKTOP-ABC123, file C:\\work\\proj\\src\\a.ts" },
    ]);
    const json = JSON.stringify(r.messages);
    expect(json).not.toContain("C:\\work\\proj");
    expect(json).not.toContain("DESKTOP-ABC123");
    expect(json).toContain("<PATH:");
    expect(r.changed).toBe(true);
  });

  it("локальному: пути остаются", () => {
    const g = local();
    const r = g.sanitizeChat([{ role: "user", content: "open C:\\work\\proj\\src\\a.ts" }]);
    expect(String((r.messages as Array<{ content: string }>)[0].content)).toContain(
      "C:\\work\\proj\\src\\a.ts",
    );
    expect(r.changed).toBe(false);
  });

  it("секрет прячется даже от локального", () => {
    const g = local();
    const r = g.sanitizeChat([{ role: "user", content: "api_key=sk-abcdefghij0123456789" }]);
    expect(JSON.stringify(r.messages)).not.toContain("sk-abcdefghij0123456789");
  });

  it("ре-гидратация возвращает оригинал (INV-D5)", () => {
    const g = external();
    const src = "open C:\\work\\proj\\src\\a.ts";
    const r = g.sanitizeChat([{ role: "user", content: src }]);
    const projected = String((r.messages as Array<{ content: string }>)[0].content);
    expect(projected).not.toBe(src);
    expect(g.rehydrateArgs(projected)).toBe(src);
  });

  it("external редактирует и определения тулов", () => {
    const g = external();
    const r = g.sanitizeChat([{ role: "user", content: "hi" }], [
      { type: "function", function: { name: "open", description: "reads C:\\work\\proj\\x" } },
    ]);
    expect(JSON.stringify(r.tools)).not.toContain("C:\\work\\proj");
  });
});

describe("kill-switch", () => {
  it("enabled=false — движок не вмешивается", () => {
    const g = createGuard({
      config: { ...cfg, enabled: false },
      target: { kind: "provider", trusted: false },
      ctx,
    });
    const r = g.sanitizeChat([{ role: "user", content: "open C:\\work\\proj\\src\\a.ts" }]);
    expect(r.changed).toBe(false);
  });
});
