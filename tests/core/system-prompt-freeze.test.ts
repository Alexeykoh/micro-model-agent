import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type PromptPhaseHost } from "../../src/core/agent/prompt-phase";
import { diffPrompt, buildPromptSnapshot } from "../../src/core/agent/prefix-monitor";
import type { PromptBlock } from "../../src/core/types";
import type { AgentDeps } from "../../src/core/agent";
import { DEFAULTS } from "../../src/config/defaults";

/**
 * Системный промпт имутабелен ВНУТРИ хода: карта проекта меняется после каждой
 * записи файла (индексер пересобирается), и без снимка это рвало KV-кеш
 * префикса на каждой итерации (наблюдалось вживую: стабильность 51%,
 * `cacheCause: "system"`). Аудит §8.7.
 */

function mapBlock(content: string): PromptBlock {
  return {
    source: "indexer",
    label: "indexer: карта проекта",
    content,
    priority: "normal",
    essential: false,
    estimatedTokens: 10,
    kind: "project-map",
  };
}

function hostWith(mapContent: () => string): PromptPhaseHost {
  const deps = {
    config: { ...structuredClone(DEFAULTS), contextWindow: 100_000 },
    promptBlocks: [],
    getDynamicPromptBlocks: () => [mapBlock(mapContent())],
    llmProvider: { countTokens: (s: string) => Math.ceil(s.length / 4) },
    pluginManager: { runOnBuildPrompt: () => [] },
  } as unknown as AgentDeps;
  return {
    deps,
    promptOverrides: new Map(),
    overflowHintBlock: null,
    frozenMapBlock: null,
  };
}

function promptSnapshot(host: PromptPhaseHost) {
  const built = buildSystemPrompt(host).prompt;
  return buildPromptSnapshot([{ role: "system", content: built }], []);
}

describe("системный промпт: карта проекта — снимок на ход", () => {
  it("keeps the system prompt byte-identical when the project map changes mid-run", () => {
    let map = "Карта: src/a.ts";
    const host = hostWith(() => map);

    const first = buildSystemPrompt(host).prompt;
    // Запись файла → индексер пересобрался → карта изменилась.
    map = "Карта: src/a.ts, src/b.ts";
    const second = buildSystemPrompt(host).prompt;

    expect(second).toBe(first);
  });

  it("refreshes the snapshot on the next turn", () => {
    let map = "Карта: src/a.ts";
    const host = hostWith(() => map);

    const first = buildSystemPrompt(host).prompt;
    map = "Карта: src/a.ts, src/b.ts";
    // Граница хода: агент сбрасывает снимок (turn-run.ts).
    host.frozenMapBlock = null;
    const second = buildSystemPrompt(host).prompt;

    expect(second).not.toBe(first);
    expect(second).toContain("src/b.ts");
  });

  it("the prefix monitor sees no break when the map changes mid-run", () => {
    let map = "Карта: src/a.ts";
    const host = hostWith(() => map);
    const countTokens = (s: string) => Math.ceil(s.length / 4);

    const before = promptSnapshot(host);
    map = "Карта: src/a.ts, src/b.ts, src/c.ts";
    const after = promptSnapshot(host);
    // Снимок держит карту первой итерации внутри хода.
    const delta = diffPrompt(before, after, countTokens);
    expect(delta.cause).toBe("none");
  });
});
