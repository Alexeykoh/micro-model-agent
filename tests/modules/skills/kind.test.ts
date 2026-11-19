import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillsLoader } from "../../../src/modules/skills/loader";

/**
 * Лoader помечает каждый скилл видом источника (`builtin`/`global`/`project`),
 * чтобы панель веба могла отделить встроенные от внешних (спека
 * `2026-11-10-skills-panel-builtin-design.md`). Без этой правки поля `kind`
 * нет вовсе и группировка не строится.
 */

function writeSkill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: d\n---\nbody`, "utf-8");
}

describe("скиллы: вид источника", () => {
  it("каждый каталог получает свой kind; при конфликте имён kind победителя сохраняется", () => {
    const root = mkdtempSync(join(tmpdir(), "mma-skill-kind-"));
    const builtin = join(root, "b");
    const globalDir = join(root, "g");
    const project = join(root, "p");
    writeSkill(builtin, "alpha");
    writeSkill(builtin, "shared");
    writeSkill(globalDir, "beta");
    writeSkill(globalDir, "shared");
    writeSkill(project, "gamma");
    writeSkill(project, "shared");
    const byName = new Map(
      new SkillsLoader().loadFromAllSources(builtin, globalDir, project).map((s) => [s.name, s]),
    );
    expect(byName.get("alpha")?.kind).toBe("builtin");
    expect(byName.get("beta")?.kind).toBe("global");
    expect(byName.get("gamma")?.kind).toBe("project");
    // Дедуп по имени выигрывает проект — и его kind остаётся при победителе.
    expect(byName.get("shared")?.kind).toBe("project");
  });

  it("loadFromDir без явного kind — внешний (global)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-kind-default-"));
    writeSkill(dir, "solo");
    const [skill] = new SkillsLoader().loadFromDir(dir);
    expect(skill?.kind).toBe("global");
  });
});
