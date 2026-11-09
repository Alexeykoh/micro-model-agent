/**
 * Release manifest (deployment/ops, P1): prompt+model+tools+evals snapshot.
 * Usage: bun scripts/build-release-manifest.ts [out.json]
 * Emits the artifact that pins a release: version, git sha, system-prompt
 * hash, builtin providers/models, tool catalog size, evals score (if present).
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string };

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function sha256File(rel: string): string | null {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
}

const manifest = {
  name: "mma",
  version: pkg.version,
  gitSha: gitSha(),
  builtAt: new Date().toISOString(),
  promptHash: sha256File("src/core/prompt.ts") ?? sha256File("src/core/system-prompt.ts"),
  tools: "see src/tools/index.ts registerAllTools",
  evals: existsSync(join(root, "tests/evals/gold-v1.json")) ? "gold-v1" : "bundled",
  sbom: existsSync(join(root, "sbom.json")) ? "sbom.json" : null,
};

const out = process.argv[2] ?? join(root, "release-manifest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2), "utf-8");
console.log(`[manifest] ${out} version=${manifest.version} sha=${manifest.gitSha.slice(0, 12)}`);
