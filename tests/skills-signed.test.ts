import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SkillsLoader, skillManifestSignatureOk } from "../src/modules/skills/loader";

const SKILL = "---\nname: t\n---\nbody\n";

describe("signed skills manifest", () => {
  it("unsigned manifest still loads (sha-only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sig-"));
    writeFileSync(join(dir, "a.skill.md"), SKILL, "utf-8");
    writeFileSync(join(dir, "skills-manifest.json"), JSON.stringify({ "a.skill.md": createHash("sha256").update(SKILL).digest("hex") }), "utf-8");
    expect(skillManifestSignatureOk(dir)).toBe(true);
    expect(new SkillsLoader().loadFromDir(dir)).toHaveLength(1);
  });

  it("valid signature loads, broken signature fail-closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-sig-"));
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(join(dir, "a.skill.md"), SKILL, "utf-8");
    const manifest = JSON.stringify({ "a.skill.md": createHash("sha256").update(SKILL).digest("hex") });
    writeFileSync(join(dir, "skills-manifest.json"), manifest, "utf-8");
    const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    writeFileSync(join(dir, "skills-manifest.pubkey"), pubPem, "utf-8");
    const sig = cryptoSign(null, Buffer.from(manifest), privateKey).toString("base64");
    writeFileSync(join(dir, "skills-manifest.sig.json"), JSON.stringify({ manifestSha256: createHash("sha256").update(manifest).digest("hex"), sig }), "utf-8");
    expect(skillManifestSignatureOk(dir)).toBe(true);
    expect(new SkillsLoader().loadFromDir(dir)).toHaveLength(1);

    // Tamper with manifest after signing -> fail-closed (empty dir load).
    writeFileSync(join(dir, "skills-manifest.json"), manifest.replace("a.skill.md", "a.skill.md "), "utf-8");
    void readFileSync;
    expect(skillManifestSignatureOk(dir)).toBe(false);
    expect(new SkillsLoader().loadFromDir(dir)).toHaveLength(0);
  });
});
