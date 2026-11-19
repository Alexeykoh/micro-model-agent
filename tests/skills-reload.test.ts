// Перезагрузка навыков без рестарта: новый `.md` виден, удалённый выгружает��я,
// счётчик токенов пересчитывается. Модуль мутируется НА МЕСТЕ — `load_skill`
// замкнул инстанс при построении реестра тулов, per-session раннеры держат тот
// же объект из `BootstrapResult`.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillsLoader } from "../src/modules/skills/loader";
import { SkillsModule } from "../src/modules/skills/module";

function skillFile(name: string, description: string, body = "step one"): string {
  return `---
name: ${name}
description: ${description}
---

${body}
`;
}

describe("SkillsModule.reload", () => {
  let builtinDir: string;
  let globalDir: string;
  let projectDir: string;
  let module: SkillsModule;

  function rescan(): void {
    module.reloadSources();
  }

  beforeEach(() => {
    builtinDir = mkdtempSync(join(tmpdir(), "mma-skills-b-"));
    globalDir = mkdtempSync(join(tmpdir(), "mma-skills-g-"));
    projectDir = join(mkdtempSync(join(tmpdir(), "mma-skills-p-")), "skills");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "alpha.skill.md"), skillFile("alpha", "first skill"));
    const loader = new SkillsLoader();
    const available = loader.loadFromAllSources(builtinDir, globalDir, projectDir);
    module = new SkillsModule(available, 10_000, { builtinDir, globalDir, projectDir });
  });

  afterEach(() => {
    for (const dir of [builtinDir, globalDir]) rmSync(dir, { recursive: true, force: true });
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  });

  it("makes a newly written skill visible without a restart", () => {
    expect(module.getAvailable().map((s) => s.name)).toEqual(["alpha"]);
    writeFileSync(join(projectDir, "beta.skill.md"), skillFile("beta", "written at runtime"));
    rescan();
    expect(module.getAvailable().map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
    // И главное: `load_skill` может его загрузить в том же ходе.
    const result = module.loadByName("beta");
    expect(result.success).toBe(true);
    expect(module.getLoaded().map((s) => s.name)).toEqual(["beta"]);
  });

  it("unloads a loaded skill whose file disappeared", () => {
    expect(module.loadByName("alpha").success).toBe(true);
    expect(module.getLoaded()).toHaveLength(1);
    rmSync(join(projectDir, "alpha.skill.md"));
    rescan();
    expect(module.getLoaded()).toHaveLength(0);
    expect(module.getAvailable()).toHaveLength(0);
    // Бюджет освобождён — токены не текут.
    expect(module.loadByName("alpha").success).toBe(false);
  });

  it("reports added/removed counts", () => {
    writeFileSync(join(projectDir, "beta.skill.md"), skillFile("beta", "new"));
    rmSync(join(projectDir, "alpha.skill.md"));
    const result = module.reloadSources();
    expect(result).toEqual({ added: 1, removed: 1 });
  });

  it("keeps a still-present loaded skill and re-accounts its tokens", () => {
    expect(module.loadByName("alpha").success).toBe(true);
    writeFileSync(join(projectDir, "gamma.skill.md"), skillFile("gamma", "third"));
    rescan();
    expect(module.getLoaded().map((s) => s.name)).toEqual(["alpha"]);
    // Повторная загрузка должна честно сказать «уже загружен», а не съесть бюджет.
    expect(module.loadByName("alpha").success).toBe(false);
  });

  it("is a no-op without sources", () => {
    const bare = new SkillsModule([], 1000);
    expect(bare.reloadSources()).toEqual({ added: 0, removed: 0 });
  });

  it("reload via explicit rescan works without sources wired", () => {
    const loader = new SkillsLoader();
    const available = loader.loadFromAllSources(builtinDir, globalDir, projectDir);
    const bare = new SkillsModule(available, 1000);
    expect(bare.getAvailable()).toHaveLength(1);
    writeFileSync(join(projectDir, "delta.skill.md"), skillFile("delta", "fourth"));
    const res = bare.reload(() =>
      loader.loadFromAllSources(builtinDir, globalDir, projectDir),
    );
    expect(res.added).toBe(1);
    expect(bare.getAvailable()).toHaveLength(2);
  });
});