import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillsLoader } from "../../../src/modules/skills/loader";
import { SkillsModule } from "../../../src/modules/skills/module";

function writeSkill(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body, "utf-8");
}

describe("skills module: onChange on load/unload", () => {
  it("notifies subscribers when a skill is loaded", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-notify-"));
    writeSkill(dir, "alpha", "---\nname: alpha\ndescription: a\n---\nbody");
    const loader = new SkillsLoader();
    const skills = loader.loadFromDir(dir);
    const mod = new SkillsModule(skills, 1000);

    let fired = 0;
    let lastNames: string[] = [];
    const unsub = mod.onChange((loaded) => {
      fired++;
      lastNames = loaded.map((s) => s.name);
    });

    const result = mod.loadByName("alpha");
    expect(result.success).toBe(true);
    expect(fired).toBe(1);
    expect(lastNames).toEqual(["alpha"]);

    unsub();
    mod.loadByName("alpha"); // already loaded
    expect(fired).toBe(1); // no new notify on failure
  });

  it("does not notify on a failed load", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-notify-fail-"));
    const loader = new SkillsLoader();
    const skills = loader.loadFromDir(dir);
    const mod = new SkillsModule(skills, 1000);

    let fired = 0;
    mod.onChange(() => { fired++; });

    const result = mod.loadByName("nope");
    expect(result.success).toBe(false);
    expect(fired).toBe(0);
  });

  it("notifies on unload", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-unload-"));
    writeSkill(dir, "alpha", "---\nname: alpha\ndescription: a\n---\nbody");
    const loader = new SkillsLoader();
    const skills = loader.loadFromDir(dir);
    const mod = new SkillsModule(skills, 1000);
    mod.loadByName("alpha");

    let fired = 0;
    let lastNames: string[] = [];
    mod.onChange((loaded) => {
      fired++;
      lastNames = loaded.map((s) => s.name);
    });

    const ok = mod.unload("alpha");
    expect(ok).toBe(true);
    expect(fired).toBe(1);
    expect(lastNames).toEqual([]);
  });

  it("a throwing subscriber does not break loading", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-throw-"));
    writeSkill(dir, "alpha", "---\nname: alpha\ndescription: a\n---\nbody");
    const loader = new SkillsLoader();
    const skills = loader.loadFromDir(dir);
    const mod = new SkillsModule(skills, 1000);

    mod.onChange(() => { throw new Error("boom"); });
    const result = mod.loadByName("alpha");
    expect(result.success).toBe(true);
    expect(mod.getLoaded().map((s) => s.name)).toEqual(["alpha"]);
  });
});