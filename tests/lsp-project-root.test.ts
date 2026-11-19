import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findProjectRoot } from "../src/modules/lsp/project-root";

describe("findProjectRoot", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lsp-root-"));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("returns baseDir when no configured marker exists anywhere", () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    const file = join(tmp, "src", "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    expect(findProjectRoot(file, tmp, ["package.json", "tsconfig.json"])).toBe(tmp);
  });

  it("finds the nearest ancestor containing a configured marker", () => {
    mkdirSync(join(tmp, "bicycle-shop", "src"), { recursive: true });
    writeFileSync(join(tmp, "bicycle-shop", "tsconfig.json"), "{}");
    const file = join(tmp, "bicycle-shop", "src", "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    expect(findProjectRoot(file, tmp, ["package.json", "tsconfig.json"])).toBe(
      join(tmp, "bicycle-shop"),
    );
  });

  it("uses the language's own markers (e.g. go.mod for Go), not JS markers", () => {
    mkdirSync(join(tmp, "svc", "cmd"), { recursive: true });
    writeFileSync(join(tmp, "svc", "go.mod"), "module svc\n");
    const file = join(tmp, "svc", "cmd", "main.go");
    writeFileSync(file, "package main\n");
    // package.json absent — the walk must rely on the passed markers.
    expect(findProjectRoot(file, tmp, ["go.mod"])).toBe(join(tmp, "svc"));
    expect(findProjectRoot(file, tmp, ["package.json"])).toBe(tmp);
  });

  it("does not climb above baseDir", () => {
    mkdirSync(join(tmp, "proj", "src"), { recursive: true });
    writeFileSync(join(tmp, "package.json"), "{}");
    const file = join(tmp, "proj", "src", "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    expect(findProjectRoot(file, join(tmp, "proj"), ["package.json"])).toBe(join(tmp, "proj"));
  });

  it("does not climb above baseDir when baseDir itself is passed as filePath (probes)", () => {
    mkdirSync(join(tmp, "base", "src"), { recursive: true });
    writeFileSync(join(tmp, "base", "src", "a.ts"), "export const a = 1;\n");
    // Marker sits NEXT TO baseDir (its parent) — must NOT be picked up.
    writeFileSync(join(tmp, "package.json"), "{}");
    expect(findProjectRoot(join(tmp, "base"), join(tmp, "base"), ["package.json"])).toBe(
      join(tmp, "base"),
    );
  });
});
