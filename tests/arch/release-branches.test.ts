import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Release channel gate (AGENTS.md -> "Каналы версий").
 *
 * Versions must never mix between channels: master = stable, dev = next,
 * vX_Y_Z = release snapshot, pre = rolling pointer. The gate checks that the
 * version declared by the current ref matches the kind of that ref, and that
 * pre suffixes live only in tags.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
};

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function currentRef(): string | null {
  if (process.env.GITHUB_REF) return process.env.GITHUB_REF;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch && branch !== "HEAD") return `refs/heads/${branch}`;
  const tag = git("describe", "--exact-match", "--tags", "HEAD");
  return tag ? `refs/tags/${tag}` : null;
}

function compare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const ref = currentRef();
const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
const tag = ref?.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : null;

describe("release branch/version invariants", () => {
  it("package.json never carries a pre suffix", () => {
    expect(pkg.version, "the -pre.N suffix belongs to the tag, not package.json").toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it(`current ref (${ref ?? "detached"}) declares the right version`, () => {
    if (tag) {
      const match = /^v(\d+\.\d+\.\d+)(-pre\.\d+)?$/.exec(tag);
      expect(match, `tag must be vX.Y.Z or vX.Y.Z-pre.N, got ${tag}`).not.toBeNull();
      expect(match?.[1]).toBe(pkg.version);
      return;
    }
    if (branch === "master" || branch === "dev" || branch === "pre") {
      // All three carry the plain base version; the channel is told apart by
      // the ref itself and by which tags may be pushed from it.
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
      return;
    }
    const release = branch ? /^v(\d+)_(\d+)_(\d+)$/.exec(branch) : null;
    if (release) {
      expect(`${release[1]}.${release[2]}.${release[3]}`).toBe(pkg.version);
    }
  });

  it("dev stays ahead of master", () => {
    // Meaningful on the integration branch; feature branches and detached
    // checkouts have no channel version to compare.
    if (branch !== "dev") return;
    const masterPkg = git("show", "master:package.json");
    if (!masterPkg) return;
    const masterVersion = (JSON.parse(masterPkg) as { version: string }).version;
    expect(
      compare(pkg.version, masterVersion),
      `dev (${pkg.version}) must be ahead of master (${masterVersion})`,
    ).toBeGreaterThan(0);
  });
});
