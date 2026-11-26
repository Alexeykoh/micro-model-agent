import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneSpills } from "../../src/tools/admission";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
let root: string;

function session(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function artifact(dir: string, name: string, ageDays: number): string {
  const path = join(dir, name);
  writeFileSync(path, "x");
  const ts = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, ts, ts);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mma-spill-gc-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("admission spill retention", () => {
  it("removes stale artifacts from old sessions and keeps fresh and current ones", () => {
    const old = session("s-old");
    const current = session("s-current");
    const stale = artifact(old, "stale.txt", 9);
    const fresh = artifact(old, "fresh.txt", 1);
    const inUse = artifact(current, "in-use.txt", 30);

    const result = pruneSpills(root, { now: NOW, skipDir: current });

    expect(result.removed).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(inUse)).toBe(true);
  });

  it("enforces a per-session cap, deleting the oldest extras", () => {
    const dir = session("s-many");
    const paths = [5, 4, 3, 2, 1].map((age, i) => artifact(dir, `${i}.txt`, age));
    const result = pruneSpills(root, { now: NOW, ttlMs: 30 * DAY, maxPerSession: 3 });

    expect(result.removed).toBe(2);
    expect(paths.slice(0, 2).every((p) => !existsSync(p))).toBe(true);
    expect(paths.slice(2).every((p) => existsSync(p))).toBe(true);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it("tolerates a missing spill root", () => {
    rmSync(root, { recursive: true, force: true });
    expect(pruneSpills(root, { now: NOW }).removed).toBe(0);
  });
});
