import { describe, it, expect } from "vitest";
import { ToolRegistry, registerAllTools } from "../../src/tools/index";

/**
 * Гейт декларации политик тулов (W2.1, INV-9/10).
 *
 * Поле `security` обязательно по типу, поэтому «тул без декларации» не
 * компилируется. Гейт проверяет форму: `caps` — массив, `manual` — с причиной
 * и датой (иначе отказка от декларации неотличима от забывчивости).
 */
describe("tool security declarations (W2.1)", () => {
  it("every builtin tool declares caps, and manual entries carry a reason", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const bad: string[] = [];
    for (const tool of registry.getAll()) {
      const s = tool.security;
      if (!s || !Array.isArray(s.caps)) {
        bad.push(`${tool.name}: missing caps`);
        continue;
      }
      if (s.manual && (!s.manual.reason || !s.manual.reviewedBy || !s.manual.date)) {
        bad.push(`${tool.name}: manual without reason/reviewedBy/date`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
    expect(registry.getAll().length).toBeGreaterThan(0);
  });

  it("bash is declared proc-only and honestly manual (shell validation stays in the handler)", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const bash = registry.get("bash");
    expect(bash?.security.caps).toContainEqual({ proc: true });
    expect(bash?.security.manual?.reason).toContain("command-validator");
  });

  it("file tools declare fs caps and path args", () => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    expect(registry.get("read_file")?.security).toMatchObject({
      caps: [{ fs: "read" }],
      pathArgs: ["path"],
    });
    expect(registry.get("write_file")?.security).toMatchObject({
      caps: [{ fs: "write" }],
      pathArgs: ["path"],
    });
    expect(registry.get("web_fetch")?.security).toMatchObject({
      caps: [{ net: true }],
      urlArgs: ["url"],
    });
  });

  it("caps agree with the declared argument policies (W2.4)", () => {
    // Инвариант: политика применяется к аргументам, значит cap обязан совпасть.
    // pathArgs ⇒ fs-cap; urlArgs ⇒ net-cap. Иначе декларация врёт о возможностях.
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const bad: string[] = [];
    for (const tool of registry.getAll()) {
      const s = tool.security;
      if (!s) continue;
      const hasFs = s.caps.some((c) => "fs" in c);
      const hasNet = s.caps.some((c) => "net" in c);
      if (s.pathArgs?.length && !hasFs) bad.push(`${tool.name}: pathArgs without fs cap`);
      if (s.urlArgs?.length && !hasNet) bad.push(`${tool.name}: urlArgs without net cap`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
