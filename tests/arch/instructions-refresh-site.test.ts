import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Инвариант (INV-1/INV-6): AGENTS.md — живой источник, но читается он только
 * в двух точках: при bootstrap и на границе хода. Прямое чтение из хендлера
 * или каждой итерации рвёт KV-кеш и делает системный промпт нестабильным.
 */

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function callersOf(symbol: string): string[] {
  return walk(SRC)
    .filter((p) => readFileSync(p, "utf-8").includes(`${symbol}(`))
    .map((p) => relative(ROOT, p).split("\\").join("/"));
}

describe("AGENTS.md: точки чтения и обновления", () => {
  it("reads AGENTS.md only at bootstrap and at the turn boundary", () => {
    const allowed = new Set([
      "src/core/bootstrap/instructions.ts", // определение loadAgentsMdBlocks
      "src/core/bootstrap/modules-prompt.ts", // стартовая сборка
      "src/core/prompt-instructions.ts", // граница хода
    ]);
    expect(callersOf("loadAgentsMdBlocks").every((p) => allowed.has(p))).toBe(true);
  });

  it("refreshes instructions only from the turn coordinator", () => {
    const allowed = new Set([
      "src/core/prompt-instructions.ts", // определение
      "src/core/agent/turn-run.ts", // единственный вызов
    ]);
    expect(callersOf("refreshInstructionBlocks").every((p) => allowed.has(p))).toBe(true);
  });
});
