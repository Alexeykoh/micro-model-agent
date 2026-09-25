import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SkillsLoader } from "../src/modules/skills/loader";
import { SkillsModule } from "../src/modules/skills/module";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("SkillsLoader", () => {
  let tmpDir: string;
  let loader: SkillsLoader;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-skills-"));
    loader = new SkillsLoader();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("should load skill from YAML frontmatter file", () => {
    const skillContent = `---
name: typescript-expert
description: TypeScript type system expert
keywords: [typescript, generics, types]
---
Some skill content here`;
    writeFileSync(join(tmpDir, "typescript.md"), skillContent);
    const skills = loader.loadFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("typescript-expert");
    expect(skills[0].keywords).toContain("typescript");
  });

  it("should skip files without frontmatter", () => {
    writeFileSync(join(tmpDir, "plain.txt"), "no frontmatter");
    const skills = loader.loadFromDir(tmpDir);
    expect(skills).toHaveLength(0);
  });

  it("loads a CRLF (Windows checkout) skill instead of silently dropping it", () => {
    const skillContent =
      "---\r\nname: crlf-skill\r\ndescription: Windows line endings\r\n---\r\nBody\r\n";
    writeFileSync(join(tmpDir, "crlf.md"), skillContent);
    const skills = loader.loadFromDir(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("crlf-skill");
  });
});

describe("SkillsModule.getSystemPromptBlock", () => {
  const makeSkills = () => [
    {
      name: "git-expert",
      description: "Git branching, merge conflicts, rebasing",
      keywords: ["git"],
      content: "git skill content",
    },
    {
      name: "ts-expert",
      description: "TypeScript type system, generics",
      keywords: ["typescript"],
      content: "ts skill content",
    },
  ];

  it("should include available skills in prompt so agent knows what to load", () => {
    const mod = new SkillsModule(makeSkills() as any, 1000);
    const block = mod.getSystemPromptBlock();

    expect(block).not.toBeNull();
    expect(block!.content).toContain("[Available Skills]");
    expect(block!.content).toContain("git-expert");
    expect(block!.content).toContain("ts-expert");
  });

  it("should include full skill content after loading", () => {
    const mod = new SkillsModule(makeSkills() as any, 1000);
    mod.loadByName("git-expert");
    const block = mod.getSystemPromptBlock();

    expect(block).not.toBeNull();
    expect(block!.content).toContain("[Available Skills]");
    expect(block!.content).toContain("[Loaded Skills]");
    expect(block!.content).toContain("git-expert");
    expect(block!.content).toContain("git skill content");
  });

  it("should return null when no skills available", () => {
    const mod = new SkillsModule([], 1000);
    const block = mod.getSystemPromptBlock();
    expect(block).toBeNull();
  });

  it("should be dynamic (reflects loaded/unloaded state)", () => {
    const mod = new SkillsModule(makeSkills() as any, 1000);
    expect(mod.getSystemPromptBlock()!.content).not.toContain("[Loaded Skills]");

    mod.loadByName("git-expert");
    expect(mod.getSystemPromptBlock()!.content).toContain("[Loaded Skills]");
    expect(mod.getSystemPromptBlock()!.content).toContain("git skill content");

    mod.unload("git-expert");
    expect(mod.getSystemPromptBlock()!.content).not.toContain("[Loaded Skills]");
  });
});

describe("SkillsModule plugin", () => {
  const makeSkills = () => [
    {
      name: "git-expert",
      description: "Git branching, merge conflicts, rebasing",
      keywords: ["git", "branch", "merge"],
      content: "git skill content here",
    },
    {
      name: "ts-expert",
      description: "TypeScript type system, generics",
      keywords: ["typescript", "generics"],
      content: "ts skill content here",
    },
  ];

  it("should NOT auto-load matching skill on onBeforeThink", () => {
    const mod = new SkillsModule(makeSkills() as any, 1000);
    const plugin = mod.getPlugin();

    expect(mod.getLoaded()).toHaveLength(0);

    plugin.onBeforeThink!({
      lastUserMessage: "how to resolve git merge conflict?",
    });

    expect(mod.getLoaded()).toHaveLength(0);
  });

  it("should allow loadByName", () => {
    const mod = new SkillsModule(makeSkills() as any, 1000);

    const result = mod.loadByName("git-expert");
    expect(result.success).toBe(true);
    expect(mod.getLoaded()).toHaveLength(1);
  });

  it("should not load if budget exceeded", () => {
    const mod = new SkillsModule(makeSkills() as any, 5);

    const result = mod.loadByName("git-expert");
    expect(result.success).toBe(false);
    expect(mod.getLoaded()).toHaveLength(0);
  });

  it("should not load unknown skill", () => {
    const mod = new SkillsModule(makeSkills() as any, 1000);

    const result = mod.loadByName("unknown-skill");
    expect(result.success).toBe(false);
    expect(mod.getLoaded()).toHaveLength(0);
  });

  it("should not load same skill twice", () => {
    const mod = new SkillsModule(makeSkills() as any, 1000);

    const r1 = mod.loadByName("git-expert");
    expect(r1.success).toBe(true);

    const r2 = mod.loadByName("git-expert");
    expect(r2.success).toBe(false);
    expect(mod.getLoaded()).toHaveLength(1);
  });
});
