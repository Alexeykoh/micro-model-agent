import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SkillUsage } from "../../../src/modules/skills/usage";

/**
 * Статистика использования скиллов: счётчики, персистентность и устойчивость
 * к битому файлу (TODO §1.10 — каталог в промпте только топ-10).
 */
describe("SkillUsage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-skill-usage-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts loads and returns zero for an unknown name", () => {
    const usage = new SkillUsage(dir);
    usage.recordLoad("git-expert");
    usage.recordLoad("git-expert");

    expect(usage.count("git-expert")).toBe(2);
    expect(usage.count("never-loaded")).toBe(0);
  });

  it("persists counts and reloads them from the same directory", () => {
    const first = new SkillUsage(dir);
    first.recordLoad("alpha");
    first.recordLoad("alpha");
    first.recordLoad("beta");

    const second = new SkillUsage(dir);
    expect(second.count("alpha")).toBe(2);
    expect(second.count("beta")).toBe(1);
    expect(second.topNames(2)).toEqual(["alpha", "beta"]);
  });

  it("writes the usage file inside the given global directory", () => {
    const usage = new SkillUsage(dir);
    usage.recordLoad("alpha");

    const raw = readFileSync(join(dir, "skills-usage.json"), "utf-8");
    expect(raw).toContain("alpha");
  });

  it("tolerates a corrupt usage file and keeps recording", () => {
    writeFileSync(join(dir, "skills-usage.json"), "{not json", "utf-8");
    const usage = new SkillUsage(dir);

    expect(usage.count("alpha")).toBe(0);
    usage.recordLoad("alpha");

    const reloaded = new SkillUsage(dir);
    expect(reloaded.count("alpha")).toBe(1);
  });

  it("ignores empty or non-string names", () => {
    const usage = new SkillUsage(dir);
    usage.recordLoad("");
    usage.recordLoad("   ");
    usage.recordLoad(undefined as unknown as string);

    expect(usage.topNames(5)).toEqual([]);
  });

  it("orders by count desc, then name, and omits zero counts", () => {
    const usage = new SkillUsage(dir);
    usage.recordLoad("c");
    usage.recordLoad("b");
    usage.recordLoad("b");
    usage.recordLoad("a");

    expect(usage.topNames(5)).toEqual(["b", "a", "c"]);
    expect(usage.topNames(2)).toEqual(["b", "a"]);
  });
});
