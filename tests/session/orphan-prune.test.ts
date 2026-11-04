/**
 * Прунинг каталогов-сирот (INV-W4, спека 2026-11-04-webui-latency-design, C4).
 *
 * Удаляется только каталог, содержащий ровно один пустой `temp` — форма,
 * которую оставляло эагерное создание `temp` в `createSessionContext`
 * (3 856 сирот в `~/.mma/sessions`). Мета, логи, посторонние файлы и пустой
 * каталог (создание сессии в процессе) не трогаются.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneOrphanSessionDirs } from "../../src/modules/session/prune";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-orphan-"));
  dirs.push(dir);
  return dir;
}

function orphan(base: string, id: string): string {
  const dir = join(base, id);
  mkdirSync(join(dir, "temp"), { recursive: true });
  return dir;
}

describe("orphan session dirs (INV-W4)", () => {
  it("removes a dir that holds nothing but an empty temp", () => {
    const base = makeBase();
    orphan(base, "orphan-1");
    expect(pruneOrphanSessionDirs(base)).toBe(1);
    expect(existsSync(join(base, "orphan-1"))).toBe(false);
  });

  it("keeps a session with meta, a log, or any other file", () => {
    const base = makeBase();

    const withMeta = join(base, "with-meta");
    mkdirSync(withMeta, { recursive: true });
    writeFileSync(join(withMeta, "meta.json"), "{}");

    const withLog = join(base, "with-log");
    mkdirSync(withLog, { recursive: true });
    writeFileSync(join(withLog, "session.jsonl"), "{}\n");

    const withTempFiles = orphan(base, "with-temp-files");
    writeFileSync(join(withTempFiles, "temp", "scratch.txt"), "x");

    expect(pruneOrphanSessionDirs(base)).toBe(0);
    expect(existsSync(withMeta)).toBe(true);
    expect(existsSync(withLog)).toBe(true);
    expect(existsSync(withTempFiles)).toBe(true);
  });

  it("keeps an empty dir (a create() in flight) and a non-empty temp", () => {
    const base = makeBase();
    mkdirSync(join(base, "in-flight"), { recursive: true });
    const nested = orphan(base, "nested-temp");
    mkdirSync(join(nested, "temp", "sub"), { recursive: true });

    expect(pruneOrphanSessionDirs(base)).toBe(0);
    expect(existsSync(join(base, "in-flight"))).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it("ignores files at the top level and a missing base dir", () => {
    const base = makeBase();
    writeFileSync(join(base, "stray.jsonl.gz"), "x");
    expect(pruneOrphanSessionDirs(base)).toBe(0);
    expect(existsSync(join(base, "stray.jsonl.gz"))).toBe(true);

    expect(pruneOrphanSessionDirs(join(base, "does-not-exist"))).toBe(0);
  });

  it("is idempotent: the second run finds nothing", () => {
    const base = makeBase();
    orphan(base, "orphan-1");
    expect(pruneOrphanSessionDirs(base)).toBe(1);
    expect(pruneOrphanSessionDirs(base)).toBe(0);
  });
});
