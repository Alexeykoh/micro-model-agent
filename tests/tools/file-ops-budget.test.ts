// Guard: бюджет файловых операций виден модели до блокировки (6 ×
// "Maximum file operations exceeded" в сессии ses_mwmeoln9).
import { describe, it, expect } from "vitest";
import { fileOpsBudgetNote, FILE_OPS_WARN_REMAINING } from "../../src/tools/file-ops-budget";
import { finalizeToolResult } from "../../src/tools/executor-result";
import type { ToolContext, ToolCall, ToolResult } from "../../src/tools/types";
import type { RegisteredTool } from "../../src/tools/registry";

function ctx(count: number, max = 100): ToolContext {
  return {
    config: { security: { maxFileOperations: max } },
    fileOperationsCount: count,
  } as unknown as ToolContext;
}

const call = { name: "write_file", arguments: { path: "src/a.ts" } } as ToolCall;

describe("видимый бюджет файловых операций", () => {
  it("молчит, когда остатка много", () => {
    expect(fileOpsBudgetNote(ctx(50), call)).toBe("");
  });

  it("предупреждает заранее и называет остаток", () => {
    const note = fileOpsBudgetNote(ctx(100 - FILE_OPS_WARN_REMAINING), call);
    expect(note).toContain(String(FILE_OPS_WARN_REMAINING));
    expect(note).toContain("100");
  });

  it("на пределе требует завершиться без новых правок", () => {
    const note = fileOpsBudgetNote(ctx(100), call);
    expect(note.toLowerCase()).toContain("finish");
  });

  it("не трогает не-файловые тулы", () => {
    expect(fileOpsBudgetNote(ctx(100), { name: "bash" } as ToolCall)).toBe("");
  });

  it("executor добавляет заметку к результату файлового тула", () => {
    const tool = { name: "write_file" } as RegisteredTool;
    const result = { success: true, output: "ok" } as ToolResult;
    const out = finalizeToolResult(ctx(100), tool, call, result);
    expect(out.output).toContain("file operations");
  });
});
