import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pickExistingPath } from "../src/modules/browser/bridge-path";

describe("bridgeScriptPath candidate resolution", () => {
  let tmp: string;

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("picks the sibling bridge-server.mjs when present (source layout)", () => {
    tmp = mkdtempSync(join(tmpdir(), "bridge-src-"));
    const sibling = join(tmp, "bridge-server.mjs");
    writeFileSync(sibling, "// bridge");
    const nested = join(tmp, "modules", "browser", "bridge-server.mjs");
    mkdirSync(join(tmp, "modules", "browser"), { recursive: true });
    writeFileSync(nested, "// bridge");
    expect(pickExistingPath([sibling, nested])).toBe(sibling);
  });

  it("picks the nested dist/modules/browser bridge when only it exists (bundled layout)", () => {
    // Regression (v0.37.0): the bundle is dist/main.js, so the single-candidate
    // lookup resolved dist/bridge-server.mjs — a path copy-assets.ts never
    // produces (it copies to dist/modules/browser/). The browser tool died with
    // ENOENT in the released npm package.
    tmp = mkdtempSync(join(tmpdir(), "bridge-dist-"));
    const sibling = join(tmp, "bridge-server.mjs");
    const nested = join(tmp, "modules", "browser", "bridge-server.mjs");
    mkdirSync(join(tmp, "modules", "browser"), { recursive: true });
    writeFileSync(nested, "// bridge");
    expect(pickExistingPath([sibling, nested])).toBe(nested);
  });

  it("falls back to the first candidate when nothing exists", () => {
    tmp = mkdtempSync(join(tmpdir(), "bridge-none-"));
    const sibling = join(tmp, "bridge-server.mjs");
    const nested = join(tmp, "modules", "browser", "bridge-server.mjs");
    expect(pickExistingPath([sibling, nested])).toBe(sibling);
  });
});