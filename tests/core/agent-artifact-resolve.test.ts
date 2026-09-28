import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveArtifactStates } from "../../src/core/agent/artifact-resolve";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifact-resolve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveArtifactStates", () => {
  it("reports missing files", () => {
    const out = resolveArtifactStates(dir, "Файл schema.drawio создан.");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "schema.drawio", exists: false });
  });

  it("parses the drawio failure mode from the qwen run", () => {
    writeFileSync(
      join(dir, "schema.drawio"),
      `<mxfile><diagram name="d"/><mxGraphModel></mxGraphModel></diagram></mxfile>`,
    );
    const out = resolveArtifactStates(dir, "schema.drawio валиден.");
    expect(out).toHaveLength(1);
    expect(out[0].exists).toBe(true);
    expect(out[0].parseError).toContain("Mismatched tag");
  });

  it("accepts valid JSON and well-formed XML", () => {
    writeFileSync(join(dir, "a.json"), `{"a": 1}`);
    writeFileSync(join(dir, "b.xml"), `<root><child/></root>`);
    const out = resolveArtifactStates(dir, "a.json создан, b.xml готов.");
    expect(out.find((a) => a.path === "a.json")).toMatchObject({ exists: true });
    expect(out.find((a) => a.path === "b.xml")?.parseError).toBeUndefined();
  });

  it("rejects broken JSON and skips paths escaping baseDir", () => {
    writeFileSync(join(dir, "bad.json"), "{ nope");
    const out = resolveArtifactStates(dir, "bad.json создан. sub/../../evil.json создан.");
    expect(out.find((a) => a.path === "bad.json")?.parseError).toContain("invalid JSON");
    expect(out.some((a) => a.path.includes("evil"))).toBe(false);
  });
});
