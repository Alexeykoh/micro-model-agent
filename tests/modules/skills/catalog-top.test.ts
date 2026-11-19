import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillUsage } from "../../../src/modules/skills/usage";
import { SkillsModule } from "../../../src/modules/skills/module";
import type { SkillMeta } from "../../../src/modules/skills/loader";

/**
 * Каталог `[Available Skills]` показывает только топ-10 по использованию,
 * остальные — строкой «and N more» (архив TODO §1.10, спека
 * `2026-11-03-skill-usage-top-design.md`).
 */

function makeSkills(count: number): SkillMeta[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `s${String(i).padStart(2, "0")}`,
    kind: "global" as const,
    description: `skill ${i}`,
    keywords: [],
    content: `content ${i}`,
    sourcePath: `memory/s${i}.md`,
  }));
}

function blockText(module: SkillsModule): string {
  const block = module.getCatalogBlock();
  expect(block).not.toBeNull();
  return block!.content;
}

describe("skills catalog: top-10 by usage", () => {
  let dir: string;
  let usage: SkillUsage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-skill-catalog-"));
    usage = new SkillUsage(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists exactly the ten most-used skills and hides the rest", () => {
    const skills = makeSkills(15);
    // s14 — самый используемый, s05 — десятый; s04…s00 не использовались.
    for (let i = 14; i >= 5; i--) {
      const name = `s${String(i).padStart(2, "0")}`;
      for (let n = 0; n < i; n++) usage.recordLoad(name);
    }

    const module = new SkillsModule(skills, 100_000, undefined, usage);
    const text = blockText(module);

    for (let i = 14; i >= 5; i--) {
      expect(text).toContain(`- s${String(i).padStart(2, "0")}`);
    }
    expect(text).not.toContain("- s04");
    expect(text).toContain("5 more");
    expect(module.getCatalogBlock()!.degraded?.reason).toContain("5 more");
  });

  it("falls back to the available order when nothing has been used", () => {
    const module = new SkillsModule(makeSkills(15), 100_000, undefined, usage);
    const text = blockText(module);

    for (let i = 0; i < 10; i++) {
      expect(text).toContain(`- s${String(i).padStart(2, "0")}`);
    }
    expect(text).not.toContain("- s10");
    expect(text).toContain("5 more");
  });

  it("records usage on a successful load and ranks the skill first", () => {
    const module = new SkillsModule(makeSkills(15), 100_000, undefined, usage);
    const result = module.loadByName("s12");
    expect(result.success).toBe(true);
    expect(usage.count("s12")).toBe(1);

    const text = blockText(module);
    const firstSkillLine = text.split("\n").find((line) => line.startsWith("- "));
    expect(firstSkillLine).toBe("- s12");
  });
});
