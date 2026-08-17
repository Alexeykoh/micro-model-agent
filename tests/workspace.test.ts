import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveProjectPath, hasProjectManifest, clearWorkspaceCache } from "../src/core/workspace";

describe("resolveProjectPath", () => {
  let baseDir: string;

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), "mma-ws-"));
    // baseDir itself is NOT a project root (no manifest).
    mkdirSync(join(baseDir, "app", "src"), { recursive: true });
    writeFileSync(join(baseDir, "app", "package.json"), "{}");
    writeFileSync(join(baseDir, "app", "src", "index.ts"), "export const x = 1");

    // Non-manifest subdirectory that also happens to contain the file.
    mkdirSync(join(baseDir, "helper", "src"), { recursive: true });
    writeFileSync(join(baseDir, "helper", "src", "index.ts"), "export const y = 2");
    writeFileSync(join(baseDir, "helper", "src", "other.ts"), "export const z = 3");
  });

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
    clearWorkspaceCache();
  });

  it("resolves a file directly under baseDir", () => {
    writeFileSync(join(baseDir, "top.ts"), "export const t = 0");
    const result = resolveProjectPath(baseDir, "top.ts");
    expect(result).toBe(join(baseDir, "top.ts"));
  });

  it("passes absolute paths through", () => {
    const abs = join(baseDir, "app", "src", "index.ts");
    expect(resolveProjectPath(baseDir, abs)).toBe(abs);
  });

  it("finds a path inside a nested project root (manifest subdir)", () => {
    const result = resolveProjectPath(baseDir, "src/index.ts");
    expect(result).toBe(join(baseDir, "app", "src", "index.ts"));
  });

  it("falls back to a non-manifest subdir when no manifest subdir matches", () => {
    const result = resolveProjectPath(baseDir, "src/other.ts");
    // `app` has no other.ts; only `helper` matches тАФ use the fallback match.
    expect(result).toBe(join(baseDir, "helper", "src", "other.ts"));
  });

  it("returns the baseDir-relative path when nothing exists (stays missing)", () => {
    const result = resolveProjectPath(baseDir, "src/ghost.ts");
    expect(result).toBe(join(baseDir, "src", "ghost.ts"));
  });

  it("does not probe subdirectories when baseDir itself is a project root", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mma-ws-proj-"));
    writeFileSync(join(projectDir, "package.json"), "{}");
    mkdirSync(join(projectDir, "app"), { recursive: true });
    writeFileSync(join(projectDir, "app", "config.ts"), "export const c = 1");

    // baseDir has a manifest тАФ `config.ts` must resolve against baseDir only.
    const result = resolveProjectPath(projectDir, "config.ts");
    expect(result).toBe(join(projectDir, "config.ts"));

    rmSync(projectDir, { recursive: true, force: true });
    clearWorkspaceCache();
  });

  it("detects project roots via manifests", () => {
    expect(hasProjectManifest(join(baseDir, "app"))).toBe(true);
    expect(hasProjectManifest(join(baseDir, "helper"))).toBe(false);
    expect(hasProjectManifest(baseDir)).toBe(false);
  });
});
