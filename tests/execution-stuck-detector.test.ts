import { describe, it, expect, beforeEach } from "vitest";
import {
  StuckDetector,
  classifyError,
} from "../src/modules/execution/stuck-detector";

describe("StuckDetector", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("should not trigger initially", () => {
    expect(detector.isStuck()).toBe(false);
  });

  it("should trigger after threshold iterations without step change", () => {
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(1);
    }
    expect(detector.isStuck()).toBe(true);
  });

  it("should reset on step change", () => {
    for (let i = 0; i < 4; i++) detector.recordIteration(1);
    detector.recordIteration(2);
    expect(detector.isStuck()).toBe(false);
  });

  it("should not reset counter when setCurrentStep repeats the same step", () => {
    for (let i = 0; i < 6; i++) {
      detector.setCurrentStep(1, "step one");
      detector.recordIteration(1);
    }
    expect(detector.isStuck()).toBe(true);
  });

  it("should reset counter when setCurrentStep moves to a new step", () => {
    for (let i = 0; i < 5; i++) {
      detector.setCurrentStep(1, "step one");
      detector.recordIteration(1);
    }
    detector.setCurrentStep(2, "step two");
    detector.recordIteration(2);
    expect(detector.isStuck()).toBe(false);
  });

  it("should detect repetitive tool errors", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError("bash");
    }
    expect(detector.hasRepetitiveErrors("bash")).toBe(true);
  });

  // checkOffTrack removed — duplicate of checkPlanAlignment in module.ts

  it("should return recovery message when stuck", () => {
    for (let i = 0; i < 6; i++) {
      detector.recordIteration(1);
    }
    expect(detector.isStuck()).toBe(true);
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toBeTruthy();
    expect(recovery).toContain("different approach");
  });

  it("should return empty recovery message when not stuck", () => {
    detector.recordIteration(1);
    expect(detector.isStuck()).toBe(false);
    expect(detector.getRecoveryMessage()).toBe("");
  });

  it("should return recovery message for repetitive tool errors", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError("bash");
    }
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toBeTruthy();
    expect(recovery).toContain("bash");
  });

  it("should classify timeout as transient", () => {
    expect(classifyError("request timed out after 30s")).toBe("transient");
  });

  it("should classify permission denied as blocking", () => {
    expect(classifyError("EACCES: permission denied")).toBe("blocking");
  });

  it("should classify file not found as systematic", () => {
    expect(classifyError("ENOENT: no such file or directory")).toBe(
      "systematic",
    );
  });

  it("should escalate after threshold", () => {
    const d = new StuckDetector(8, 3);
    expect(d.shouldEscalate()).toBe(false);
    d.recordEscalation();
    d.recordEscalation();
    d.recordEscalation();
    expect(d.shouldEscalate()).toBe(true);
  });

  it("should reset escalation on success", () => {
    const d = new StuckDetector(8, 3);
    d.recordEscalation();
    d.recordEscalation();
    d.recordToolSuccess();
    expect(d.getEscalationCount()).toBe(0);
  });

  it("should track file rewrites", () => {
    const d = new StuckDetector(8, 3);
    d.recordFileRewrite("src/index.ts");
    d.recordFileRewrite("src/index.ts");
    d.recordFileRewrite("src/index.ts");
    expect(d.hasExcessiveRewrites()).toBe(true);
    expect(d.getExcessiveRewriteFile()).toBe("src/index.ts");
  });

  it("should not flag files rewritten less than threshold", () => {
    const d = new StuckDetector(8, 3);
    d.recordFileRewrite("src/index.ts");
    d.recordFileRewrite("src/index.ts");
    expect(d.hasExcessiveRewrites()).toBe(false);
  });

  it("should track last error output", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError("bash", "EACCES: permission denied");
    expect(d.getLastErrorOutput()).toBe("EACCES: permission denied");
  });

  it("should return last failed tool", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError("bash", "some error");
    expect(d.getLastFailedTool()).toBe("bash");
  });

  it("should suggest actionable hints for TypeScript syntax errors", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError(
      "bash",
      "src/index.ts(10,12): error TS1005: ',' expected.",
    );
    const hints = d.getActionableHints();
    expect(hints.some((h) => h.includes("syntax error"))).toBe(true);
  });

  it("should suggest actionable hints for runtime incompatibility", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError(
      "bash",
      "TypeError: Cannot read properties of undefined (reading 'fileExists') at node_modules/ts-node/dist/configuration.js",
    );
    const hints = d.getActionableHints();
    expect(hints.some((h) => h.includes("incompatible"))).toBe(true);
  });

  it("should suggest actionable hints for TypeScript type errors", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError(
      "bash",
      "src/index.ts(16,17): error TS2769: No overload matches this call.",
    );
    const hints = d.getActionableHints();
    expect(hints.some((h) => h.includes("type mismatch"))).toBe(true);
  });

  it("should suggest actionable hints for command not found", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError(
      "bash",
      "'ts-node' is not recognized as an internal or external command",
    );
    const hints = d.getActionableHints();
    expect(hints.some((h) => h.includes("not found"))).toBe(true);
  });

  it("should suggest tool alternative for ts-node crash", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError(
      "bash",
      "TypeError: Cannot read properties of undefined (reading 'fileExists') at node_modules/ts-node/dist/configuration.js",
    );
    const alt = d.getToolAlternative();
    expect(alt).toBe("tsx");
  });

  it("should return null for tool alternative when no crash pattern", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError("bash", "some random error");
    const alt = d.getToolAlternative();
    expect(alt).toBeNull();
  });

  it("should return empty actionable hints when no error", () => {
    const d = new StuckDetector(8, 3);
    expect(d.getActionableHints()).toEqual([]);
  });

  it("should clear toolErrors on step change", () => {
    for (let i = 0; i < 3; i++) detector.recordToolError("bash");
    expect(detector.hasRepetitiveErrors("bash")).toBe(true);
    detector.setCurrentStep(2, "step two");
    expect(detector.hasRepetitiveErrors("bash")).toBe(false);
  });

  it("should clear consecutiveFailures on step change", () => {
    for (let i = 0; i < 3; i++) detector.recordToolError("bash");
    expect(detector.hasConsecutiveFailures()).toBe(true);
    detector.setCurrentStep(2, "step two");
    expect(detector.hasConsecutiveFailures()).toBe(false);
  });

  it("should clear recentToolCalls on step change", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordToolCall("read_file", { path: "src/index.ts" });
    }
    expect(detector.hasRepetitiveToolCalls()).toBe(true);
    detector.setCurrentStep(2, "step two");
    expect(detector.hasRepetitiveToolCalls()).toBe(false);
  });

  it("should clear fileRewriteCount on step change", () => {
    for (let i = 0; i < 3; i++) detector.recordFileRewrite("src/index.ts");
    expect(detector.hasExcessiveRewrites()).toBe(true);
    detector.setCurrentStep(2, "step two");
    expect(detector.hasExcessiveRewrites()).toBe(false);
  });

  it("should preserve escalation across step change", () => {
    detector.recordEscalation();
    detector.recordEscalation();
    detector.recordEscalation();
    expect(detector.shouldEscalate()).toBe(true);
    detector.setCurrentStep(2, "step two");
    // Escalation count is preserved — agent cannot escape by moving to next step
    expect(detector.shouldEscalate()).toBe(true);
  });

  it("should clear last error output on step change", () => {
    detector.recordToolError("bash", "EACCES: permission denied");
    expect(detector.getLastErrorOutput()).toBe("EACCES: permission denied");
    detector.setCurrentStep(2, "step two");
    expect(detector.getLastErrorOutput()).toBe("");
  });

  it("should keep error state when setCurrentStep repeats the same step", () => {
    detector.setCurrentStep(1, "step one");
    for (let i = 0; i < 3; i++) detector.recordToolError("bash");
    detector.setCurrentStep(1, "step one");
    expect(detector.hasRepetitiveErrors("bash")).toBe(true);
    expect(detector.hasConsecutiveFailures()).toBe(true);
  });

  it("should clear state on recordIteration step change", () => {
    for (let i = 0; i < 3; i++) detector.recordToolError("bash");
    expect(detector.hasConsecutiveFailures()).toBe(true);
    detector.recordIteration(2);
    expect(detector.hasConsecutiveFailures()).toBe(false);
    expect(detector.getIterationsOnCurrentStep()).toBe(1);
  });
});

describe("StuckDetector bash awareness (R3)", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("suggests checking the entry point after repeated empty CLI runs", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordBashOutput("bun run src/cli.ts data.csv", "");
    }
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("EMPTY output"))).toBe(true);
    expect(hints.some((h) => h.includes("entry point"))).toBe(true);
  });

  it("does not fire the empty-output hint on a single empty run", () => {
    detector.recordBashOutput("bun run src/cli.ts data.csv", "");
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("EMPTY output"))).toBe(false);
  });

  it("hints about PowerShell cmdlets in cmd.exe", () => {
    detector.recordToolError("bash", '"Write-Host" не является внутренней или внешней командой');
    detector.recordBashOutput("bun run ./src/cli.ts | Write-Host", "err");
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("PowerShell"))).toBe(true);
  });

  it("hints about invented Bun APIs", () => {
    detector.recordToolError("bash", "TypeError: Bun.fileExistsSync is not a function");
    detector.recordBashOutput("bun test", "TypeError: Bun.fileExistsSync is not a function");
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("does not exist"))).toBe(true);
  });

  it("hints about bash heredoc inside cmd.exe", () => {
    detector.recordToolError("bash", "Непредвиденное появление: <<.");
    detector.recordBashOutput("cat > out.txt << 'EOF'", "Непредвиденное появление: <<.");
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("Heredoc"))).toBe(true);
  });

  it("resets bash awareness on step change", () => {
    for (let i = 0; i < 3; i++) {
      detector.recordBashOutput("bun run src/cli.ts data.csv", "");
    }
    detector.setCurrentStep(2, "next step");
    detector.recordBashOutput("bun run src/cli.ts data.csv", "");
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("EMPTY output"))).toBe(false);
  });
});

describe("StuckDetector typecheck awareness (R5.2)", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("hints to read the file instead of rewriting blindly on typecheck errors", () => {
    detector.recordToolError("write_file", "[Project typecheck failed]: src/a.ts(14,19): error TS2322");
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("rewriting the whole file blindly"))).toBe(true);
  });

  it("rewrite-loop hint fires when a typecheck-tagged file keeps being rewritten", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordFileRewrite("src/a.ts");
      detector.recordToolError("write_file", "[Project typecheck failed]: src/a.ts(14,19): error TS2322");
    }
    expect(detector.hasExcessiveRewrites()).toBe(true);
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("rewritten"))).toBe(true);
    expect(hints.some((h) => h.includes("rewriting the whole file blindly"))).toBe(true);
  });
});

describe("StuckDetector read-without-write loop detection", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("does not flag a short burst of reads", () => {
    for (let i = 0; i < 5; i++) {
      detector.recordToolCall("read_file", { path: `src/${i}.ts` });
    }
    expect(detector.hasReadOnlyLoop()).toBe(false);
  });

  it("flags a long run of read-only tool calls", () => {
    for (let i = 0; i < 12; i++) {
      detector.recordToolCall("read_file", { path: `src/file${i}.ts` });
    }
    expect(detector.hasReadOnlyLoop()).toBe(true);
  });

  it("resets the read-only streak when a write tool is called", () => {
    for (let i = 0; i < 10; i++) {
      detector.recordToolCall("read_file", { path: `src/${i}.ts` });
    }
    expect(detector.hasReadOnlyLoop()).toBe(true);
    detector.recordToolCall("write_file", { path: "src/out.ts" });
    expect(detector.hasReadOnlyLoop()).toBe(false);
  });

  it("treats plan/todo bookkeeping as read-only (does not count as progress)", () => {
    for (let i = 0; i < 12; i++) {
      detector.recordToolCall("plan", { action: "show" });
    }
    expect(detector.hasReadOnlyLoop()).toBe(true);
  });

  it("clears the read-only streak on step change", () => {
    for (let i = 0; i < 12; i++) {
      detector.recordToolCall("read_file", { path: `src/${i}.ts` });
    }
    expect(detector.hasReadOnlyLoop()).toBe(true);
    detector.setCurrentStep(2, "next step");
    expect(detector.hasReadOnlyLoop()).toBe(false);
  });
});
