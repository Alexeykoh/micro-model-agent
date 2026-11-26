// AQC-1…8: ключевые инварианты ветки 0.26.1 как архитектурный гейт.
// Тесты поведения живут рядом с модулями; здесь — только контрактные точки.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");

describe("architecture: agent quality control 0.26.1", () => {
  it("AQC-1: пропущенное evidence требует behavioral", () => {
    expect(read("src/modules/execution/plan-checks.ts")).toContain(
      'return target.evidence !== "static"',
    );
  });

  it("AQC-2: file-modified проверяется хэшем, не mtime", () => {
    const src = read("src/modules/execution/step-advance.ts");
    expect(src).not.toMatch(/parsed\.kind === "file-modified"[\s\S]{0,300}provablyStale/);
  });

  it("AQC-3: degraded critic не равен pass", () => {
    expect(read("src/core/agent/critic-contract.ts")).toContain('"degraded"');
  });

  it("AQC-4: тул отключается после ≤3 падений", () => {
    const src = read("src/core/agent/constants.ts");
    const m = src.match(/MAX_TOOL_FAILURES_PER_TURN\s*=\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(3);
  });

  it("AQC-5: ранняя компакция для ≤64K", () => {
    expect(read("src/core/agent/compaction-early.ts")).toContain("earlySmallReason");
  });

  it("AQC-6: patch_file зарегистрирован", () => {
    expect(read("src/tools/index.ts")).toContain("patchFileTool");
  });

  it("AQC-7: сетевой обрыв классифицируется как transient", () => {
    expect(read("src/llm/openai-stream.ts")).toContain("isTransientNetworkFailure");
  });

  it("AQC-8: уборка процессов живёт отдельным хелпером", () => {
    expect(read("src/core/agent/turn-process-cleanup.ts")).toContain("kill");
  });
});
