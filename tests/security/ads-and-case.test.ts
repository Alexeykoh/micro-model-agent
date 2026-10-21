import { describe, it, expect } from "vitest";
import { matchProtectedPath } from "../../src/modules/security/protected-paths";
import { isPathInScope } from "../../src/modules/security/path-validator";
import type { PathSecurityConfig } from "../../src/config/types";

/**
 * Защита путей: NTFS alternate data stream и регистр (аудит §4.2/§4.3,
 * план `2026-10-12-harness-module-audit-fixes`, W3/Task 3.2).
 */

const win = process.platform === "win32";

describe("protected paths: ADS + регистр", () => {
  it("blocks a protected file hidden behind an NTFS alternate data stream", () => {
    const base = "E:\\proj";
    expect(matchProtectedPath(base, "E:\\proj\\.env::$DATA")).toBeDefined();
    expect(matchProtectedPath(base, "E:\\proj\\.git\\config::$DATA")).toBeDefined();
    expect(matchProtectedPath(base, "E:\\proj\\server.key:stream")).toBeDefined();
  });

  it("keeps an ordinary POSIX name with a colon intact", () => {
    if (win) return;
    expect(matchProtectedPath("/proj", "/proj/.env:notes")).toBeUndefined();
  });
});

describe("deny-glob: имя файла и регистр", () => {
  const base = "/home/user/project";
  const cfg = (denied: string[]): PathSecurityConfig => ({
    enabled: true,
    denied,
    allowed: [],
  });

  it("blocks a nested file matching a name pattern", () => {
    const res = isPathInScope(base, "certs/private.key", undefined, cfg(["*.key"]));
    expect(res.allowed).toBe(false);
  });

  it("blocks a nested exact name", () => {
    const res = isPathInScope(base, "certs/.env", undefined, cfg([".env"]));
    expect(res.allowed).toBe(false);
  });

  it("folds case on win32", () => {
    if (!win) return;
    const res = isPathInScope(base, "certs/PRIVATE.KEY", undefined, cfg(["*.key"]));
    expect(res.allowed).toBe(false);
  });

  it("keeps case sensitivity on POSIX", () => {
    if (win) return;
    const res = isPathInScope(base, "certs/PRIVATE.KEY", undefined, cfg(["*.key"]));
    expect(res.allowed).toBe(true);
  });

  it("still matches a ** pattern", () => {
    const res = isPathInScope(base, "a/secrets/b.txt", undefined, cfg(["**/secrets/**"]));
    expect(res.allowed).toBe(false);
  });

  it("does not match an unrelated path", () => {
    const res = isPathInScope(base, "src/index.ts", undefined, cfg(["*.key", "**/secrets/**"]));
    expect(res.allowed).toBe(true);
  });
});
