import { describe, it, expect, afterEach } from "vitest";
import { Indexer, isIgnoredDirName } from "../../../src/modules/indexer/walker";
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
});

describe("isIgnoredDirName", () => {
  it("matches known vendor dirs case-insensitively", () => {
    expect(isIgnoredDirName("venv")).toBe(true);
    expect(isIgnoredDirName(".venv")).toBe(true);
    expect(isIgnoredDirName("Venv")).toBe(true);
    expect(isIgnoredDirName("node_modules")).toBe(true);
    expect(isIgnoredDirName("target")).toBe(true);
  });

  it("does not match ordinary source directories", () => {
    expect(isIgnoredDirName("src")).toBe(false);
    expect(isIgnoredDirName("environment")).toBe(false);
    expect(isIgnoredDirName("about")).toBe(false);
  });
});
