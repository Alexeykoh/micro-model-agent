import { describe, it, expect, afterEach } from "vitest";
import { Indexer, isIgnoredDirName, isIgnoredFileName } from "../../../src/modules/indexer/walker";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let tempDir: string | null = null;

function makeProject(): string {
  tempDir = mkdtempSync(join(tmpdir(), "mma-walker-"));
  const write = (rel: string, content = "x") => {
    const full = join(tempDir!, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  write("src/app.ts", "export const app = 1");
  write("src/main.py", "def main(): pass");
  write("src/lib.rs", "pub fn run() {}");
  write("src/main.go", "package main");
  // Vendor / build / cache dirs that must never be indexed.
  write("venv/lib/python3.11/site.py", "import os");
  write(".venv/bin/activate", "#!/bin/sh");
  write("node_modules/pkg/index.js", "module.exports = 1");
  write("target/debug/build.rs", "fn x() {}");
  write("__pycache__/main.cpython-311.pyc", "**");
  write("vendor/github.com/lib/lib.go", "package lib");
  // MMA dev / agent dirs (dev-only; mirror .gitignore).
  write("_testing/case/main.ts", "export const t = 1");
  write(".superpowers/plans/x.md", "# plan");
  write(".opencode/opencode.json", "{}");
  write(".fallow-baseline.json", "{}");
  write(".fallow/health.json", "{}");
  // Generated / tooling files.
  write("package-lock.json", "{}");
  write(".fallowrc.json", "{}");
  // Vendored / minified bundles.
  write("src/modules/webui/assets/hljs.js", "var hljs=1");
  write("src/modules/webui/assets/smd.js", "var smd=1");
  write("libs/vendor.min.js", "!function(){}()");
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe("Indexer.walk", () => {
  it("indexes source files including non-JS languages", async () => {
    const dir = makeProject();
    const result = await new Indexer(dir).walk();
    const paths = result.files.map((f) => f.path.replace(/\\/g, "/")).sort();
    expect(paths).toContain("src/app.ts");
    expect(paths).toContain("src/main.py");
    expect(paths).toContain("src/lib.rs");
    expect(paths).toContain("src/main.go");
  });

  it("skips virtualenv, vendor, build and cache directories", async () => {
    const dir = makeProject();
    const result = await new Indexer(dir).walk();
    const paths = result.files.map((f) => f.path.replace(/\\/g, "/"));
    for (const ignored of ["venv/", ".venv/", "node_modules/", "target/", "__pycache__/", "vendor/"]) {
      expect(paths.some((p) => p.startsWith(ignored))).toBe(false);
    }
  });

  it("skips MMA dev / agent dirs (test sandboxes, scratch, tooling)", async () => {
    const dir = makeProject();
    const result = await new Indexer(dir).walk();
    const paths = result.files.map((f) => f.path.replace(/\\/g, "/"));
    for (const ignored of ["_testing/", ".superpowers/", ".opencode/", ".fallow/"]) {
      expect(paths.some((p) => p.startsWith(ignored))).toBe(false);
    }
  });

  it("skips lockfiles and .fallow* tooling files", async () => {
    const dir = makeProject();
    const result = await new Indexer(dir).walk();
    const paths = result.files.map((f) => f.path.replace(/\\/g, "/"));
    expect(paths).not.toContain("package-lock.json");
    expect(paths).not.toContain(".fallowrc.json");
    expect(paths).not.toContain(".fallow-baseline.json");
  });

  it("skips vendored / minified bundles", async () => {
    const dir = makeProject();
    const result = await new Indexer(dir).walk();
    const paths = result.files.map((f) => f.path.replace(/\\/g, "/"));
    expect(paths).not.toContain("src/modules/webui/assets/hljs.js");
    expect(paths).not.toContain("src/modules/webui/assets/smd.js");
    expect(paths).not.toContain("libs/vendor.min.js");
  });
});

describe("isIgnoredDirName", () => {
  it("matches known vendor dirs case-insensitively", () => {
    expect(isIgnoredDirName("venv")).toBe(true);
    expect(isIgnoredDirName(".venv")).toBe(true);
    expect(isIgnoredDirName("Venv")).toBe(true);
    expect(isIgnoredDirName("node_modules")).toBe(true);
    expect(isIgnoredDirName("target")).toBe(true);
  });

  it("matches MMA dev / agent dirs", () => {
    expect(isIgnoredDirName("_testing")).toBe(true);
    expect(isIgnoredDirName(".superpowers")).toBe(true);
    expect(isIgnoredDirName(".opencode")).toBe(true);
    expect(isIgnoredDirName(".fallow")).toBe(true);
  });

  it("matches lockfiles and .fallow* files", () => {
    expect(isIgnoredFileName("package-lock.json")).toBe(true);
    expect(isIgnoredFileName("bun.lock")).toBe(true);
    expect(isIgnoredFileName(".fallow-baseline.json")).toBe(true);
    expect(isIgnoredFileName(".fallowrc.json")).toBe(true);
    expect(isIgnoredFileName("index.ts")).toBe(false);
    expect(isIgnoredFileName("fallow.ts")).toBe(false);
  });

  it("matches vendored / minified bundles", () => {
    expect(isIgnoredFileName("hljs.js")).toBe(true);
    expect(isIgnoredFileName("smd.js")).toBe(true);
    expect(isIgnoredFileName("vendor.min.js")).toBe(true);
    expect(isIgnoredFileName("app.js")).toBe(false);
    expect(isIgnoredFileName("md.js")).toBe(false);
  });

  it("does not match ordinary source directories", () => {
    expect(isIgnoredDirName("src")).toBe(false);
    expect(isIgnoredDirName("environment")).toBe(false);
    expect(isIgnoredDirName("about")).toBe(false);
  });
});
