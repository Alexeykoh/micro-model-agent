import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { safeResolvePath } from "../src/tools/path-utils";

const base = mkdtempSync(join(tmpdir(), "mma-path-utils-"));
const nested = join(base, "sub", "dir");
mkdirSync(nested, { recursive: true });

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("safeResolvePath", () => {
  it("honors an existing absolute path as-is", () => {
    expect(safeResolvePath(base, base)).toBe(resolve(base));
  });

  it("honors an existing absolute path to a nested dir", () => {
    expect(safeResolvePath(base, nested)).toBe(resolve(nested));
  });

  it("honors an existing absolute path whose parent exists (new file)", () => {
    const newFile = join(nested, "new.txt");
    expect(safeResolvePath(base, newFile)).toBe(resolve(newFile));
  });

  it("strips leading slash for non-existent paths (relative intent)", () => {
    expect(safeResolvePath(base, "/sub/dir/file.txt")).toBe(
      resolve(base, "sub/dir/file.txt"),
    );
  });

  it("resolves relative paths against baseDir", () => {
    expect(safeResolvePath(base, "sub/dir")).toBe(resolve(base, "sub/dir"));
  });
});
