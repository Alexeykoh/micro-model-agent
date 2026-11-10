import { describe, it, expect } from "vitest";
import { readdirSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "node:url";
import { SkillsLoader } from "../../../src/modules/skills/loader";

/**
 * Гвард встроенных скиллов (`src/modules/skills/builtin/`): загрузчик молча
 * отбрасывает файл с битым frontmatter (правило 5 — «инвариант = проверка»),
 * поэтому здесь явно проверяется, что каждый `.md` в каталоге действительно
 * загружается, именование уникально и тело влезает в бюджет скиллов даже на
 * минимальном контексте (32K × 0.15 ≈ 4.8K токенов).
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const BUILTIN_DIR = join(REPO_ROOT, "src", "modules", "skills", "builtin");
/** ~12K символов ≈ 3K токенов — запас против бюджета на 32K-контексте. */
const MAX_CONTENT_CHARS = 12_000;

function mdFiles(): string[] {
  return readdirSync(BUILTIN_DIR).filter((f) => f.endsWith(".md") || f.endsWith(".skill.md"));
}

describe("скиллы: встроенный каталог", () => {
  it("каждый builtin-файл проходит загрузчик (frontmatter не битый)", () => {
    const skills = new SkillsLoader().loadFromDir(BUILTIN_DIR);
    expect(skills.length, "файл отброшен молча — проверьте `---` и обязательный name").toBe(
      mdFiles().length,
    );
    expect(skills.length).toBeGreaterThanOrEqual(3);
  });

  it("имена уникальны, в kebab-case, с описанием и телом", () => {
    const skills = new SkillsLoader().loadFromDir(BUILTIN_DIR);
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(skill.description.trim().length, `${skill.name}: описание определяет, когда`).not.toBe(
        0,
      );
      expect(skill.content.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(skill.keywords)).toBe(true);
    }
  });

  it("тело каждого скилла вписывается в бюджет на минимальном контексте", () => {
    for (const skill of new SkillsLoader().loadFromDir(BUILTIN_DIR)) {
      expect(skill.content.length, `${skill.name}: тело слишком большое`).toBeLessThanOrEqual(
        MAX_CONTENT_CHARS,
      );
    }
  });

  it("скилл по руководству пользователя существует и грузится", () => {
    const skill = new SkillsLoader()
      .loadFromDir(BUILTIN_DIR)
      .find((s) => s.name === "mma-user-guide");
    expect(skill, "пользователь не получит помощь по MMA без этого скилла").toBeDefined();
    for (const needle of ["provider", "/config", "load_skill", "session", "security"]) {
      expect(skill?.content.toLowerCase()).toContain(needle);
    }
  });
});
