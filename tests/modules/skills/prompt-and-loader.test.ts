import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillsLoader } from "../../../src/modules/skills/loader";
import { SkillsModule } from "../../../src/modules/skills/module";
import { t } from "../../../src/i18n/index";

/**
 * Скиллы: положительная формулировка промпта, корректный фронтматтер
 * (YAML-блочные скаляры, BOM), приоритет проектных скиллов (аудит §2.7/§2.8,
 * план `2026-10-12-harness-module-audit-fixes`, W4/Task 4.6).
 */

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body, "utf-8");
}

describe("скиллы: промпт и загрузчик", () => {
  it("the system prompt does not forbid proactive skill loading", () => {
    const hint = t("skill.prompt_hint");
    // Запрета на загрузку быть не должно («не грузи, только по просьбе»).
    // «Не угадывайте имена» — нормальная часть новой формулировки.
    expect(hint).not.toMatch(/do not load|only load|не загружайте|только когда|только по/i);
    expect(hint).toMatch(/load_skill/i);
  });

  it("parses YAML block scalars in frontmatter", () => {
    const loader = new SkillsLoader();
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-block-"));
    writeSkill(
      dir,
      "blocky",
      "---\nname: blocky\ndescription: >\n  multi line\n  text\n---\nbody",
    );
    const skills = loader.loadFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("multi line text");
  });

  it("parses a literal block scalar with newlines", () => {
    const loader = new SkillsLoader();
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-literal-"));
    writeSkill(dir, "lit", "---\nname: lit\ndescription: |\n  line one\n  line two\n---\nbody");
    const skills = loader.loadFromDir(dir);
    expect(skills[0].description).toBe("line one\nline two");
  });

  it("strips a BOM before parsing frontmatter", () => {
    const loader = new SkillsLoader();
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-bom-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "bom.md"),
      "\uFEFF---\nname: bom\ndescription: with bom\n---\nbody",
      "utf-8",
    );
    const skills = loader.loadFromDir(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("bom");
  });

  it("a project skill shadows a builtin of the same name", () => {
    const loader = new SkillsLoader();
    const root = mkdtempSync(join(tmpdir(), "mma-skill-shadow-"));
    const builtin = join(root, "builtin");
    const global = join(root, "global");
    const project = join(root, "project");
    writeSkill(builtin, "git-expert", "---\nname: git-expert\ndescription: builtin\n---\nbuiltin body");
    writeSkill(global, "git-expert", "---\nname: git-expert\ndescription: global\n---\nglobal body");
    writeSkill(project, "git-expert", "---\nname: git-expert\ndescription: project\n---\nproject body");

    const skills = loader.loadFromAllSources(builtin, global, project);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("project");
  });

  it("does not list a duplicate skill twice", () => {
    const loader = new SkillsLoader();
    const root = mkdtempSync(join(tmpdir(), "mma-skill-dup-"));
    const builtin = join(root, "builtin");
    const global = join(root, "global");
    const project = join(root, "project");
    writeSkill(builtin, "a", "---\nname: a\ndescription: builtin a\n---\nbody");
    writeSkill(global, "b", "---\nname: b\ndescription: global b\n---\nbody");
    writeSkill(project, "a", "---\nname: a\ndescription: project a\n---\nbody");
    const skills = loader.loadFromAllSources(builtin, global, project);
    expect(skills.map((s) => s.name).sort()).toEqual(["a", "b"]);
  });

  it("the prompt block lists the description without a token counter", () => {
    const loader = new SkillsLoader();
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-prompt-"));
    writeSkill(dir, "x", "---\nname: x\ndescription: short description\n---\nbody");
    const module = new SkillsModule(loader.loadFromDir(dir), 10_000);
    const block = module.getSystemPromptBlock();
    expect(block).not.toBeNull();
    expect(block?.content).toContain("- x: short description");
    expect(block?.content).not.toMatch(/--- x \(\d+ tokens\) ---/);
  });

  it("hasAny() is false without skills", () => {
    const module = new SkillsModule([], 1000);
    expect(module.hasAny()).toBe(false);
  });
});
