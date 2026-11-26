// Гвард к docs/specs/2026-11-23-research-loop-efficiency-design.md (§1):
// модель продолжала добывать данные после того, как web_fetch уже вернул
// полный ответ, и тратила минуты на повторные запросы той же страницы.
import { describe, it, expect } from "vitest";
import { buildSystemInfo } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";

function prompt(): string {
  return buildSystemInfo(structuredClone(DEFAULTS), "/tmp/proj", "linux, node 20");
}

describe("system prompt: early exit on fetched facts", () => {
  it("contains the early-exit rule exactly once", () => {
    const text = prompt();
    expect(text).toContain("If a fetched page already answers the question, answer now");
    expect(text.split("If a fetched page already answers the question").length - 1).toBe(1);
  });

  it("keeps the live-data guidance intact", () => {
    const text = prompt();
    expect(text).toContain("LIVE DATA");
    expect(text).toContain("call web_search/web_fetch first");
  });
});
