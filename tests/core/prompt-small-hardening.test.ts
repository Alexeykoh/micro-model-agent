import { describe, it, expect } from "bun:test";
import { PromptBuilder } from "../../src/core/prompt-builder";
import { buildModelBlock, buildServiceJobPrompt } from "../../src/core/system-prompt";
import { fallbackPromptFacts } from "../../src/core/prompt-facts";
import { SkillsModule } from "../../src/modules/skills/module";
import { DEFAULTS } from "../../src/config/defaults";

describe("prompt small hardening (B7/B13/B15/B19/B20)", () => {
  it("B13: model identity block is normal priority, still evictable", () => {
    const block = buildModelBlock("test-model");
    expect(block.priority).toBe("normal");
    expect(block.essential).toBe(false);
    expect(block.content).toContain("test-model");
  });

  it("B15: unknown priority sorts as normal instead of NaN chaos", () => {
    const builder = new PromptBuilder(1000);
    builder.addBlock({ content: "high", priority: "high", essential: false, estimatedTokens: 5 });
    builder.addBlock({ content: "weird", priority: "typo", essential: false, estimatedTokens: 5 });
    builder.addBlock({ content: "low", priority: "low", essential: false, estimatedTokens: 5 });
    const prompt = builder.build().prompt;
    expect(prompt.indexOf("high")).toBeLessThan(prompt.indexOf("weird"));
    expect(prompt.indexOf("weird")).toBeLessThan(prompt.indexOf("low"));
  });

  it("B7: fallback platform comes from the machine, not the profile text", () => {
    const facts = fallbackPromptFacts(structuredClone(DEFAULTS), "/tmp", "definitely-win32-darwin");
    const expected =
      process.platform === "win32"
        ? "win32"
        : process.platform === "darwin"
          ? "darwin"
          : process.platform === "linux"
            ? "linux"
            : "unknown";
    expect(facts.platform).toBe(expected);
  });

  it("B19: glued skills block carries owner, label and catalog priority", () => {
    const module = new SkillsModule([], 1000, { builtinDir: "/tmp", globalDir: "/tmp", projectDir: "/tmp" });
    expect(module.getSystemPromptBlock()).toBeNull();
    const withSkill = new SkillsModule(
      [{ name: "s", kind: "builtin", description: "d", keywords: [], content: "BODY", sourcePath: "/tmp" }],
      1000,
      { builtinDir: "/tmp", globalDir: "/tmp", projectDir: "/tmp" },
    );
    const glued = withSkill.getSystemPromptBlock();
    expect(glued).not.toBeNull();
    expect(glued!.source).toBe("skills");
    expect(glued!.label).toBeTruthy();
    // Как каталог раздельного пути, а не high.
    expect(glued!.priority).toBe("normal");
  });

  it("B20: service-job warns about security only when tools are available", () => {
    const sec = { enabled: true } as never;
    const withTools = buildServiceJobPrompt("m", ["read_file"], sec);
    expect(withTools).toContain("SECURITY RESTRICTIONS");
    const noTools = buildServiceJobPrompt("m", [], sec);
    expect(noTools).not.toContain("SECURITY RESTRICTIONS");
    const disabled = buildServiceJobPrompt("m", ["read_file"], { enabled: false } as never);
    expect(disabled).not.toContain("SECURITY RESTRICTIONS");
  });
});
