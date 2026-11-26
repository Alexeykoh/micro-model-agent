// BCP-1/5/6: точность критика, coverage по текущему сообщению, дешёвый критик.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { filterFileClaims } from "../../src/core/agent/critic-file-claim";
import { CriticGate } from "../../src/core/agent/critic-gate";
import { createLoopState } from "../../src/core/agent/loop-state";
import { getTaskText } from "../../src/modules/execution/deliverables";

describe("BCP-1: файловые утверждения критика", () => {
  it("отбрасывает 'missing file' для существующего файла", () => {
    const dir = mkdtempSync(join(tmpdir(), "bcp1-"));
    try {
      writeFileSync(join(dir, "note.txt"), "hello\n");
      const issue = {
        severity: "critical" as const,
        claim: "Missing file",
        problem: "note.txt does not exist",
        evidence: "note.txt",
      };
      expect(filterFileClaims([issue], { baseDir: dir, toolEvents: [] })).toEqual([]);
    } finally {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("оставляет утверждение для действительно отсутствующего файла", () => {
    const issue = {
      severity: "critical" as const,
      claim: "Missing file",
      problem: "absent.ts does not exist",
    };
    expect(filterFileClaims([issue], { baseDir: tmpdir(), toolEvents: [] })).toEqual([issue]);
  });
});

describe("BCP-6: статический fastpath критика", () => {
  it("не вызывает LLM для двух успешных файловых тулов", async () => {
    const verify = vi.fn();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify,
      buildPack: (d: never) => d,
    });
    const state = createLoopState();
    const d = {
      state,
      iteration: 3,
      logger: { diagnostic: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
      contextManager: { addMessage: vi.fn() } as never,
      slog: { logCritic: vi.fn(), logDiagnosticEvent: vi.fn() } as never,
      task: "edit files",
      beforeFinish: true,
      toolEvents: [
        { tool: "write_file", ok: true },
        { tool: "patch_file", ok: true },
      ],
    } as never;
    expect(await gate.evaluate(d)).toBe("pass");
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("BCP-5: coverage по текущему сообщению", () => {
  it("берёт последнее пользовательское сообщение, не первое", () => {
    const history = [
      { role: "user", content: "Create note.txt" },
      { role: "assistant", content: "done" },
      { role: "user", content: "<system-summary>old</system-summary>" },
      { role: "user", content: "Create comp.tsx" },
    ];
    const ctx = { contextManager: { getActiveHistory: () => history } } as never;
    expect(getTaskText(ctx)).toBe("Create comp.tsx");
  });
});
