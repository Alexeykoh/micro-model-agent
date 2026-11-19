import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePromptOverflow } from "../../src/core/prompt-overflow";
import { applyOverrides } from "../../src/core/agent/prompt-blocks";
import { loadAgentsMdBlocks } from "../../src/core/bootstrap/state";
import type { PromptBlock } from "../../src/core/types";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function block(label: string, content: string): PromptBlock {
  return {
    source: "agents-md",
    label,
    content,
    priority: "high",
    essential: false,
    estimatedTokens: 20,
    kind: "instructions",
  };
}

describe("переполнение инструкций: замена по источнику", () => {
  it("keep each source's own summary instead of one shared 'instructions' replacement", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "mma-ovf-"));
    dirs.push(cacheRoot);
    const a = block("instructions (a/)", "RULE-A keep me verbatim");
    const b = block("instructions (b/)", "RULE-B keep me verbatim");
    const res = await resolvePromptOverflow({
      overflow: [a, b],
      includedTokens: 0,
      systemBudget: 400,
      provider: null,
      cacheDir: join(cacheRoot, "cache"),
      model: "test",
    });
    expect(res.replacements).toHaveLength(2);
    expect(res.replacements.map((r) => r.label).sort()).toEqual([
      "instructions (a/)",
      "instructions (b/)",
    ]);

    const overrides = new Map(res.replacements.map((r) => [r.label ?? r.kind ?? "", r]));
    const applied = applyOverrides([a, b], overrides);
    expect(applied[0]?.content).toContain("RULE-A");
    expect(applied[1]?.content).toContain("RULE-B");
    expect(applied[0]?.content).not.toContain("RULE-B");
  });

  it("root AGENTS.md is essential, nested ones are compressible", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-agents-essential-"));
    dirs.push(dir);
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# root\n", "utf-8");
    writeFileSync(join(dir, "sub", "AGENTS.md"), "# nested\n", "utf-8");

    const blocks = loadAgentsMdBlocks(dir, dir, false, [], "none");
    expect(blocks.find((b) => b.label === "instructions")?.essential).toBe(true);
    expect(blocks.find((b) => b.label?.includes("sub"))?.essential).toBe(false);
  });
});
