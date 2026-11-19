/**
 * Ленивый temp-каталог сессии (INV-W4, спека 2026-11-04-webui-latency-design, C4):
 * `createSessionContext` не пишет на диск, `getSessionTempDir` создаёт каталог
 * при первом обращении, `cleanupSessionTempDir` действительно удаляет.
 *
 * До правки каждый контекст создавал `~/.mma/sessions/<id>/temp` сразу — в
 * каталоге накопились 3 856 сирот (только пустой `temp`, без меты).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupSessionTempDir,
  createSessionContext,
  getSessionTempDir,
} from "../../src/modules/security/session-isolation";
import type { SessionContext } from "../../src/modules/security/session-isolation";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mma-isolation-"));
  roots.push(root);
  return root;
}

function contextFor(root: string, isolateTempFiles = true): SessionContext {
  return createSessionContext("sess-1", join(root, "project"), {
    enabled: true,
    isolateTempFiles,
    baseDir: join(root, "sessions"),
  });
}

describe("session temp dir is created lazily (INV-W4)", () => {
  it("createSessionContext does not write to disk", () => {
    const root = makeRoot();
    const ctx = contextFor(root);
    // `SessionIsolationConfig.baseDir` — уже каталог сессии (без id в хвосте).
    expect(ctx.tempDir).toBe(join(root, "sessions", "temp"));
    expect(existsSync(join(root, "sessions"))).toBe(false);
  });

  it("getSessionTempDir creates the directory on first use", () => {
    const root = makeRoot();
    const ctx = contextFor(root);
    expect(existsSync(ctx.tempDir)).toBe(false);

    const dir = getSessionTempDir(ctx);
    expect(dir).toBe(ctx.tempDir);
    expect(existsSync(dir)).toBe(true);
    // Повторное обращение не создаёт заново.
    expect(getSessionTempDir(ctx)).toBe(dir);
  });

  it("getSessionTempDir does not create anything when isolation is off", () => {
    const root = makeRoot();
    const ctx = contextFor(root, false);
    expect(getSessionTempDir(ctx)).toBe(ctx.tempDir);
    expect(existsSync(join(root, "sessions"))).toBe(false);
  });

  it("cleanupSessionTempDir removes the directory and tolerates a missing one", () => {
    const root = makeRoot();
    const ctx = contextFor(root);
    getSessionTempDir(ctx);
    writeFileSync(join(ctx.tempDir, "scratch.txt"), "x");

    cleanupSessionTempDir(ctx);
    expect(existsSync(ctx.tempDir)).toBe(false);
    expect(() => cleanupSessionTempDir(ctx)).not.toThrow();
  });

  it("keeps an existing temp directory intact when the session already used it", () => {
    const root = makeRoot();
    const ctx = contextFor(root);
    mkdirSync(ctx.tempDir, { recursive: true });
    writeFileSync(join(ctx.tempDir, "keep.txt"), "x");

    expect(getSessionTempDir(ctx)).toBe(ctx.tempDir);
    expect(existsSync(join(ctx.tempDir, "keep.txt"))).toBe(true);
  });
});
