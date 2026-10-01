import { describe, it, expect } from "vitest";
import { diagnoseRepeatedFailures } from "../src/core/agent/tool-batch";

describe("diagnoseRepeatedFailures (ses_mup6p61q)", () => {
  it("skips bash failures on model-invented targets", () => {
    // Сессия: «bun test tests/agent.test.ts» (файла нет) записался в
    // глобальную память как «системная проблема bash».
    const d = diagnoseRepeatedFailures("bash", [
      "bun test v1.3.14\nThe following filters did not match any test files:\n  tests/agent.test.ts",
    ]);
    expect(d.skip).toBe(true);
  });

  it("skips bare exit-code bash failures (findstr no-match and friends)", () => {
    expect(diagnoseRepeatedFailures("bash", ["(exit code 1)"]).skip).toBe(true);
  });

  it("blames the anchor (CRLF/stale read), not the tool, for edit_file misses", () => {
    const d = diagnoseRepeatedFailures("edit_file", [
      "Строка не найдена в файле:\n  iterationsSinceCompaction: number;\n}",
    ]);
    expect(d.skip).toBe(false);
    expect(d.cause).toContain("CRLF");
    expect(d.solution).toContain("read_file");
  });

  it("records genuine systemic failures with the generic text", () => {
    const d = diagnoseRepeatedFailures("bash", ["Error: spawn ENOENT", "Error: spawn ENOENT"]);
    expect(d.skip).toBe(false);
    expect(d.cause).toContain("systemic");
  });

  it("records mixed/unknown signatures instead of dropping them", () => {
    const d = diagnoseRepeatedFailures("lsp_check", ["LSP server start timeout"]);
    expect(d.skip).toBe(false);
  });
});
