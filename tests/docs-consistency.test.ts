import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Гейт «один источник правды» для описаний, которые легко развести по файлам. */
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

describe("docs: single source of truth", () => {
  it("keeps the certification tag list only in agents/testing.md", () => {
    const arch = read("docs/agents/architecture.md");
    expect(arch).not.toContain("--tags core,security,image,network,browser,moe");
    expect(arch).not.toContain("**Spec:** `docs/specs/2026-08-05-model-certification-design.md`");

    const testing = read("docs/agents/testing.md");
    expect(testing).toContain("--tags core,security,image,network,browser,shell,research");
    expect(testing).toContain("`browser`, `shell`, `research`.");
  });

  it("does not pin stale versions in live docs", () => {
    for (const rel of ["docs/mma-features-overview.md", "docs/agents/feature-history.md"]) {
      expect(read(rel)).not.toMatch(/0\.10\.x|Current Version: 0\.3\.2/);
    }
  });
});
