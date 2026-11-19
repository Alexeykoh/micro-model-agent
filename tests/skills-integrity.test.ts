import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "node:crypto";
import { SkillsLoader, skillManifestIntegrityOk } from "../src/modules/skills/loader";

describe("skill integrity manifest (supply-chain)", () => {
  it("accepts matching hash, rejects tampered/unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-manifest-"));
    const content = "---\nname: build\n---\nbody\n";
    const hash = createHash("sha256").update(content, "utf-8").digest("hex");
    writeFileSync(join(dir, "skills-manifest.json"), JSON.stringify({ "build.skill.md": hash }), "utf-8");
    expect(skillManifestIntegrityOk(dir, "build.skill.md", content)).toBe(true);
    expect(skillManifestIntegrityOk(dir, "build.skill.md", content + "edited")).toBe(false);
    expect(skillManifestIntegrityOk(dir, "other.skill.md", content)).toBe(false);
  });

  it("without manifest everything loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-nomanifest-"));
    expect(skillManifestIntegrityOk(dir, "x.md", "anything")).toBe(true);
  });

  it("loader rejects tampered skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-skill-load-"));
    writeFileSync(join(dir, "build.skill.md"), "---\nname: build\n---\nbody\n", "utf-8");
    writeFileSync(join(dir, "skills-manifest.json"), JSON.stringify({ "build.skill.md": "deadbeef" }), "utf-8");
    const loader = new SkillsLoader();
    expect(loader.loadFromDir(dir)).toEqual([]);
  });
});
