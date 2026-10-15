import { describe, it, expect, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n/index";

// Локаль — процессный синглтон: порядок файлов в раннере зависит от ФС
// (на CI иной), поэтому файлы с английскими строками пинят "en" сами.
beforeEach(() => setLocale("en"));
import { createLoadSkillTool } from "../../src/tools/load-skill";
import { SkillsModule } from "../../src/modules/skills/module";

describe("loadSkillTool", () => {
  it("has correct definition", () => {
    const skillsModule = new SkillsModule([], 1000);
    const tool = createLoadSkillTool(skillsModule);
    expect(tool.name).toBe("load_skill");
    expect(tool.description).toBeTruthy();
    expect(tool.parameters.properties).toHaveProperty("name");
    expect(tool.parameters.required).toContain("name");
  });

  it("should reject call without name", async () => {
    const skillsModule = new SkillsModule([], 1000);
    const tool = createLoadSkillTool(skillsModule);
    const result = await tool.handler({} as any, {});
    expect(result.success).toBe(false);
  });

  it("should load skill and return lightweight result", async () => {
    const skills = [
      {
        name: "test-skill",
        description: "Test",
        keywords: [],
        content: "test content",
      },
    ];
    const skillsModule = new SkillsModule(skills as any, 2000);
    const tool = createLoadSkillTool(skillsModule);

    const result = await tool.handler({} as any, { name: "test-skill" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("test-skill");
    expect(result.output).toContain("remaining");
    expect(result.output).not.toContain("test content");
  });

  it("should return error for unknown skill", async () => {
    const skillsModule = new SkillsModule([], 1000);
    const tool = createLoadSkillTool(skillsModule);

    const result = await tool.handler({} as any, { name: "unknown" });
    expect(result.success).toBe(false);
  });
});
