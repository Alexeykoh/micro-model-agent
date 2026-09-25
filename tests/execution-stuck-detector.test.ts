import { describe, it, expect, beforeEach } from "vitest";
import {
  StuckDetector,
  classifyError,
  isSearchableError,
  buildSearchQuery,
  normalizeErrorSignature,
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

  it("decays per-tool error counters on successful calls (ses_mt4fn58c)", () => {
    // bash failed 3x early in the session, then the model moved on and made
    // 30 successful write_file calls — the stale counter must not keep the
    // "Tool bash failed N times" warning alive forever.
    for (let i = 0; i < 3; i++) detector.recordToolError("bash");
    expect(detector.hasRepetitiveErrors("bash")).toBe(true);

    detector.recordToolSuccess();
    expect(detector.hasRepetitiveErrors("bash")).toBe(false);

    // Fresh failures rebuild the count from scratch.
    for (let i = 0; i < 3; i++) detector.recordToolError("bash");
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
    expect(classifyError("ENOENT: no such file or directory")).toBe("systematic");
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
    d.recordToolError("bash", "src/index.ts(10,12): error TS1005: ',' expected.");
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
    d.recordToolError("bash", "src/index.ts(16,17): error TS2769: No overload matches this call.");
    const hints = d.getActionableHints();
    expect(hints.some((h) => h.includes("type mismatch"))).toBe(true);
  });

  it("should suggest actionable hints for command not found", () => {
    const d = new StuckDetector(8, 3);
    d.recordToolError("bash", "'ts-node' is not recognized as an internal or external command");
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

describe("StuckDetector hint/recovery dedup (P3)", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("does not repeat the repetitive-tool hint when recovery already reports it", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolCall("bash", { cmd: "dir", workdir: "." });
    }
    expect(detector.hasRepetitiveToolCalls()).toBe(true);
    // Recovery's primary reason is "repetitive"
    expect(detector.getRecoveryMessage()).toContain("bash");
    const hints = detector.getHints();
    expect(hints.some((h) => h.includes("calling the same tool repeatedly"))).toBe(false);
  });

  it("does not repeat the consecutive-failures hint when recovery covers it", () => {
    detector.recordToolError("bash");
    detector.recordToolError("git");
    detector.recordToolError("bash");
    expect(detector.hasConsecutiveFailures()).toBe(true);
    expect(detector.getRecoveryMessage()).toBeTruthy();
    const hints = detector.getHints();
    expect(hints.some((h) => h.includes("Multiple different tools are failing"))).toBe(false);
  });

  it("keeps the read-only bullet when stuck is the primary reason", () => {
    detector.setCurrentStep(1, "fix src/a.ts");
    for (let i = 0; i < 12; i++) {
      detector.recordIteration(1);
      detector.recordToolCall("read_file", { path: `src/file${i}.ts` });
    }
    expect(detector.isStuck()).toBe(true);
    expect(detector.hasReadOnlyLoop()).toBe(true);
    const hints = detector.getHints();
    expect(hints.some((h) => h.includes("read-only tool calls"))).toBe(true);
  });

  it("keeps step-keyword hints even when recovery covers the state", () => {
    detector.setCurrentStep(1, "install dependencies");
    for (let i = 0; i < 4; i++) {
      detector.recordToolCall("bash", { cmd: "npm", workdir: "." });
    }
    expect(detector.hasRepetitiveToolCalls()).toBe(true);
    const hints = detector.getHints();
    expect(hints.some((h) => h.includes("lock file exists"))).toBe(true);
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
    detector.recordToolError(
      "write_file",
      "[Project typecheck failed]: src/a.ts(14,19): error TS2322",
    );
    const hints = detector.getActionableHints();
    expect(hints.some((h) => h.includes("rewriting the whole file blindly"))).toBe(true);
  });

  it("rewrite-loop hint fires when a typecheck-tagged file keeps being rewritten", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordFileRewrite("src/a.ts");
      detector.recordToolError(
        "write_file",
        "[Project typecheck failed]: src/a.ts(14,19): error TS2322",
      );
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

describe("StuckDetector error signature counting", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3, 5);
  });

  it("returns null before the threshold", () => {
    for (let i = 0; i < 4; i++) {
      detector.recordToolError("bash", "error TS2322: not assignable");
    }
    expect(detector.getRepeatedErrorSignature()).toBeNull();
  });

  it("returns the signature at the threshold with its count", () => {
    for (let i = 0; i < 5; i++) {
      detector.recordToolError("bash", "error TS2322: not assignable");
    }
    const sig = detector.getRepeatedErrorSignature();
    expect(sig).toContain("bash::");
    expect(sig).toContain("TS2322");
    expect(detector.getErrorSignatureCount(sig!)).toBe(5);
  });

  it("does not merge different errors of the same tool", () => {
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS2322: A");
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS1005: B");
    expect(detector.getRepeatedErrorSignature()).toContain("TS2322");
  });

  it("normalizes paths, line locations and ANSI codes", () => {
    const a = normalizeErrorSignature("bash", "\x1b[31merror TS2322: at C:\\proj\\src\\a.ts:12:34");
    const b = normalizeErrorSignature("bash", "error TS2322: at D:\\other\\src\\b.ts:99:1");
    expect(a).toBe(b);
    expect(a).toContain("TS2322");
  });

  it("returns null for empty output", () => {
    expect(normalizeErrorSignature("bash", "")).toBeNull();
    expect(normalizeErrorSignature("bash", undefined)).toBeNull();
  });

  it("marks a signature as searched and unmarks it for retry", () => {
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS2322");
    const sig = detector.getRepeatedErrorSignature()!;
    detector.markErrorSearched(sig);
    expect(detector.hasErrorSearched(sig)).toBe(true);
    expect(detector.getRepeatedErrorSignature()).toBeNull();
    detector.unmarkErrorSearched(sig);
    expect(detector.getRepeatedErrorSignature()).toBe(sig);
  });

  it("clears signature counts and searched flags on step change", () => {
    for (let i = 0; i < 5; i++) detector.recordToolError("bash", "error TS2322");
    const sig = detector.getRepeatedErrorSignature()!;
    detector.markErrorSearched(sig);
    detector.setCurrentStep(2, "next step");
    expect(detector.getRepeatedErrorSignature()).toBeNull();
    expect(detector.hasErrorSearched(sig)).toBe(false);
  });
});

describe("StuckDetector isSearchableError", () => {
  it("accepts real error text", () => {
    expect(isSearchableError("error TS2322: Type 'string' not assignable")).toBe(true);
    expect(isSearchableError("ERR_MODULE_NOT_FOUND: Cannot find module")).toBe(true);
    expect(isSearchableError("ENOENT: no such file or directory")).toBe(true);
    expect(isSearchableError("TypeError: Cannot read properties of undefined")).toBe(true);
    expect(isSearchableError("panic: runtime error")).toBe(true);
  });

  it("rejects empty and trivial output", () => {
    expect(isSearchableError("")).toBe(false);
    expect(isSearchableError("   ")).toBe(false);
    expect(isSearchableError("Command failed with exit code 1")).toBe(false);
    expect(isSearchableError("Process finished with exit code 1")).toBe(false);
  });
});

describe("StuckDetector buildSearchQuery", () => {
  it("uses up to 3 error lines and strips paths", () => {
    const q = buildSearchQuery(
      "run tests",
      "bun run test",
      "src/a.ts:12:34 error TS2322: X\nC:\\proj\\src\\b.ts:1:2 error TS1005: Y",
      "bash",
      200,
    );
    expect(q).not.toContain("C:\\proj");
    expect(q).toContain("TS2322");
    expect(q).toContain("how to fix");
  });

  it("adds runtime and framework from the step/bash context", () => {
    const q = buildSearchQuery(
      "install react app",
      "npm run build",
      "error: not found",
      "bash",
      200,
    );
    expect(q.toLowerCase()).toContain("npm");
    expect(q.toLowerCase()).toContain("react");
    expect(q.toLowerCase()).toContain("how to fix");
  });

  it("falls back to tool + step when error text is empty", () => {
    const q = buildSearchQuery("fix the failing build", "", "", "bash", 200);
    expect(q).toContain("bash");
    expect(q).toContain("fix the failing build");
  });

  it("caps the query length", () => {
    const q = buildSearchQuery("x", "y", "error TS2322: " + "very long ".repeat(100), "bash", 50);
    expect(q.length).toBeLessThanOrEqual(50);
  });
});

describe("StuckDetector bash flailing (P4)", () => {
  let detector: StuckDetector;

  beforeEach(() => {
    detector = new StuckDetector(5, 3);
  });

  it("does not fire below the failure threshold", () => {
    detector.recordBashAttempt(false);
    detector.recordBashAttempt(true);
    detector.recordBashAttempt(false);
    detector.recordBashAttempt(true);
    detector.recordBashAttempt(false);
    expect(detector.hasBashFlailing()).toBe(false);
  });

  it("fires when 4 of the last 6 bash attempts failed", () => {
    for (const ok of [true, false, true, false, false, false]) {
      detector.recordBashAttempt(ok);
    }
    expect(detector.hasBashFlailing()).toBe(true);
    expect(detector.getWarningKey()).toBe("bash-flailing");
    const recovery = detector.getRecoveryMessage();
    expect(recovery).toContain("bash");
    expect(recovery).toContain("read_file");
  });

  it("window slides — old failures age out", () => {
    // 4 failures then 2 successes → only 4 in window, still flailing;
    // one more success pushes the oldest failure out → 3 of 6 → clears.
    for (const ok of [false, false, false, false, true, true]) {
      detector.recordBashAttempt(ok);
    }
    expect(detector.hasBashFlailing()).toBe(true);
    detector.recordBashAttempt(true);
    expect(detector.hasBashFlailing()).toBe(false);
  });

  it("interleaved successes do not reset the counter", () => {
    // The exact ses_mt4x3zbo pattern: bash fails, read_file succeeds,
    // different bash command fails… consecutive-failure reset must not hide it.
    for (const ok of [false, true, false, true, false]) {
      detector.recordBashAttempt(ok);
      if (!ok) detector.recordToolError("bash", "cmd not found");
      else {
        detector.recordToolCall("read_file", { path: "x" });
        detector.recordToolSuccess();
      }
    }
    detector.recordBashAttempt(false);
    expect(detector.hasBashFlailing()).toBe(true);
  });

  it("reset() clears the window", () => {
    for (let i = 0; i < 6; i++) detector.recordBashAttempt(false);
    expect(detector.hasBashFlailing()).toBe(true);
    detector.reset();
    expect(detector.hasBashFlailing()).toBe(false);
  });
});

describe("StuckDetector failure classification", () => {
  let d: StuckDetector;
  beforeEach(() => {
    d = new StuckDetector(5, 3);
  });

  it("classifies no-progress iterations as timeout", () => {
    for (let i = 0; i < 6; i++) d.recordIteration(1);
    const c = d.classifyFailure(9);
    expect(c).toEqual({ type: "timeout", iteration: 9 });
  });

  it("classifies one tool failing repeatedly as error_loop (with tool + count)", () => {
    for (let i = 0; i < 4; i++) d.recordToolError("bash", "boom");
    const c = d.classifyFailure(3);
    expect(c).toMatchObject({ type: "error_loop", tool: "bash", count: 4, iteration: 3 });
  });

  it("classifies consecutive failures across tools as error_loop without a tool", () => {
    d.recordToolError("bash", "a");
    d.recordToolError("read_file", "b");
    d.recordToolError("grep", "c");
    const c = d.classifyFailure();
    expect(c?.type).toBe("error_loop");
    expect(c?.tool).toBeUndefined();
    expect(c?.count).toBe(3);
  });

  it("classifies identical repeated calls as repeat", () => {
    for (let i = 0; i < 4; i++) d.recordToolCall("read_file", { path: "src/a.ts" });
    expect(d.hasRepetitiveToolCalls()).toBe(true);
    const c = d.classifyFailure(2);
    expect(c).toMatchObject({ type: "repeat", tool: "read_file", count: 3 });
  });

  it("classifies rotating failing shell commands as bash_flailing", () => {
    for (let i = 0; i < 4; i++) d.recordBashAttempt(false);
    const c = d.classifyFailure();
    expect(c?.type).toBe("bash_flailing");
    expect(c?.count).toBe(4);
  });

  it("classifies a long read-only streak as read_only", () => {
    for (let i = 0; i < 10; i++) d.recordToolCall("read_file", { path: `src/f${i}.ts` });
    expect(d.hasReadOnlyLoop()).toBe(true);
    const c = d.classifyFailure();
    expect(c).toMatchObject({ type: "read_only", count: 10 });
  });

  it("returns null and an empty diagnostic when healthy", () => {
    expect(d.classifyFailure()).toBeNull();
    expect(d.getStuckDiagnostic()).toBe("");
  });

  it("formats a compact, parseable [STUCK: ...] diagnostic", () => {
    for (let i = 0; i < 4; i++) d.recordToolCall("read_file", { path: "src/a.ts" });
    const line = d.getStuckDiagnostic(7);
    expect(line).toContain("[STUCK: ");
    expect(line).toContain("type=repeat");
    expect(line).toContain("tool=read_file");
    expect(line).toContain("count=3");
    expect(line).toContain("iteration=7");
  });

  it("omits the tool and iteration parts when unknown", () => {
    for (let i = 0; i < 6; i++) d.recordIteration(1);
    const line = d.getStuckDiagnostic();
    expect(line).toBe("[STUCK: type=timeout]");
  });
});
