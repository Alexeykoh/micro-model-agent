import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsMdBlocks } from "../../src/core/bootstrap/state";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mma-instr-src-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("instructions.sources и CLAUDE.md fallback", () => {
  it("loads configured glob files as instruction blocks", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "rules"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Root\n", "utf-8");
    writeFileSync(join(dir, "rules", "extra.md"), "# Extra\n", "utf-8");

    const blocks = loadAgentsMdBlocks(dir, dir, false, ["rules/*.md"], "none");
    expect(blocks.some((b) => b.label === "instructions")).toBe(true);
    expect(blocks.some((b) => b.label?.includes("rules"))).toBe(true);
  });

  it("falls back to CLAUDE.md only when enabled", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "CLAUDE.md"), "# Claude rules\n", "utf-8");

    expect(loadAgentsMdBlocks(dir, dir, false, [], "none")).toHaveLength(0);
    const blocks = loadAgentsMdBlocks(dir, dir, false, [], "claude");
    expect(blocks.some((b) => b.content.includes("Claude rules"))).toBe(true);
  });

  it("AGENTS.md always wins over CLAUDE.md in the same directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "AGENTS.md"), "# Agents wins\n", "utf-8");
    writeFileSync(join(dir, "CLAUDE.md"), "# Claude loses\n", "utf-8");

    const blocks = loadAgentsMdBlocks(dir, dir, false, [], "claude");
    expect(blocks.some((b) => b.content.includes("Agents wins"))).toBe(true);
    expect(blocks.some((b) => b.content.includes("Claude loses"))).toBe(false);
  });

  it("skips missing and URL sources without throwing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "AGENTS.md"), "# Root\n", "utf-8");
    const blocks = loadAgentsMdBlocks(
      dir,
      dir,
      false,
      ["missing.md", "https://example.com/rules.md"],
      "none",
    );
    expect(blocks).toHaveLength(1);
  });
});
