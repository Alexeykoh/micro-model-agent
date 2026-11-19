import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadScenarios, filterByTags, validateScenario } from "../src/modules/certification/loader";

function tempYamlDir(contents: string): string {
  const dir = join(tmpdir(), `cert-l-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "custom.yaml"), contents);
  return dir;
}

describe("cert loader", () => {
  it("loads builtin scenarios without validation errors", () => {
    const { scenarios, errors } = loadScenarios();
    expect(errors).toEqual([]);
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it("validates unknown tag", () => {
    const errors = validateScenario({
      id: "x",
      title: "x",
      tags: ["bogus"] as any,
      mode: "run",
      prompt: "p",
      checks: [{ type: "fileExists", path: "a" }],
    });
    expect(errors.some((e) => e.includes("unknown tag"))).toBe(true);
  });

  it("validates empty checks", () => {
    const errors = validateScenario({
      id: "x",
      title: "x",
      tags: ["core"],
      mode: "run",
      prompt: "p",
      checks: [],
    });
    expect(errors.some((e) => e.includes("at least one check"))).toBe(true);
  });

  it("validates passThreshold > reps", () => {
    const errors = validateScenario({
      id: "x",
      title: "x",
      tags: ["core"],
      mode: "run",
      prompt: "p",
      reps: 2,
      passThreshold: 3,
      checks: [{ type: "exitCode" }],
    });
    expect(errors.some((e) => e.includes("passThreshold > reps"))).toBe(true);
  });

  it("loads a user YAML scenario", () => {
    const dir = tempYamlDir(
      "id: custom-1\ntitle: Custom\ntags: [core]\nmode: run\nprompt: Create file c.txt with content ok\nchecks:\n  - type: fileExists\n    path: c.txt\n",
    );
    const { scenarios, errors } = loadScenarios(dir);
    expect(errors).toEqual([]);
    expect(scenarios.some((s) => s.id === "custom-1")).toBe(true);
  });

  it("reports parse errors from bad YAML", () => {
    const dir = tempYamlDir("id: [unclosed");
    const { errors } = loadScenarios(dir);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("filterByTags defaults to core", () => {
    const { scenarios } = loadScenarios();
    const core = filterByTags(scenarios, []);
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((s) => s.tags.includes("core"))).toBe(true);
  });

  it("filterByTags selects explicit tags", () => {
    const { scenarios } = loadScenarios();
    const img = filterByTags(scenarios, ["image"]);
    expect(img.every((s) => s.tags.includes("image"))).toBe(true);
  });
});
