import { describe, it, expect } from "bun:test";
import { recommendContextSize } from "../../src/core/prompt-overflow";
import { effectiveMapTokenBudget } from "../../src/modules/indexer/module";
import { buildCatalogBlock, CATALOG_LIMIT, LARGE_CATALOG_LIMIT } from "../../src/modules/skills/catalog";
import { SkillsModule, SKILLS_LOADED_TOKENS_CAP } from "../../src/modules/skills/module";
import { resolveTuning, LARGE_COMPACTION_THRESHOLD, LARGE_TOOL_RESULT_KEEP } from "../../src/core/context/manager-state";
import { createLoadSkillTool } from "../../src/tools/load-skill";
import type { SkillMeta } from "../../src/modules/skills/loader";

function skill(name: string, size: number): SkillMeta {
  return { name, kind: "global", description: name, keywords: [], content: "x".repeat(size), sourcePath: `/tmp/${name}` };
}

describe("scale-aware budgets (L1/L2/L3)", () => {
  it("L1: recommends up to 1M windows and honors a custom fraction", () => {
    expect(recommendContextSize(3000)).toBe(32768);
    expect(recommendContextSize(3000, 0.2)).toBe(16384);
    expect(recommendContextSize(50000)).toBe(524288);
    expect(recommendContextSize(999_999_999)).toBe(1048576);
  });

  it("L2: map budget scales on large windows unless set explicitly", () => {
    expect(effectiveMapTokenBudget(undefined, 1500, 32768, 128000)).toBe(1500);
    expect(effectiveMapTokenBudget(1500, 1500, 200000, 128000)).toBe(6000);
    expect(effectiveMapTokenBudget(500, 1500, 200000, 128000)).toBe(500);
    expect(effectiveMapTokenBudget(20000, 1500, 200000, 128000)).toBe(20000);
  });

  it("L2: catalog stays at 10 on small budgets, widens on large", () => {
    const skills = Array.from({ length: 30 }, (_, i) => skill(`s${i}`, 10));
    const small = buildCatalogBlock(skills, undefined, CATALOG_LIMIT)!;
    expect(small.content.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(10);
    const large = buildCatalogBlock(skills, undefined, LARGE_CATALOG_LIMIT)!;
    expect(large.content.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(25);
    const mod = new SkillsModule(skills, 100000, undefined, undefined, LARGE_CATALOG_LIMIT);
    expect(mod.getCatalogBlock()!.content).toBe(large.content);
  });

  it("L2: loaded skill bodies hit an absolute cap on huge budgets", async () => {
    // ~4000 токенов каждый: 4000 + 4000 > 6000 cap.
    const mod = new SkillsModule([skill("a", 16000), skill("b", 16000)], 100000);
    const tool = createLoadSkillTool(mod);
    const first = await tool.handler({} as never, { name: "a" } as never);
    expect(first.success).toBe(true);
    const second = await tool.handler({} as never, { name: "b" } as never);
    // Старый код впустил бы оба: 8000 < 100000.
    expect(second.success).toBe(false);
    expect(SKILLS_LOADED_TOKENS_CAP).toBe(6000);
  });

  it("L3: compaction tuning scales on large windows unless set explicitly", () => {
    const small = resolveTuning(undefined, 32768);
    expect(small.compactionThreshold).toBe(0.75);
    expect(small.toolResultKeep).toBe(6);
    const big = resolveTuning(undefined, 200000);
    expect(big.compactionThreshold).toBe(LARGE_COMPACTION_THRESHOLD);
    expect(big.toolResultKeep).toBe(LARGE_TOOL_RESULT_KEEP);
    const explicit = resolveTuning({ compactionThreshold: 0.5, toolResultKeep: 3 }, 200000);
    expect(explicit.compactionThreshold).toBe(0.5);
    expect(explicit.toolResultKeep).toBe(3);
  });
});
