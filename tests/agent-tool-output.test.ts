import { describe, it, expect } from "vitest";
import {
  toolOutputCharLimit,
  compactToolError,
  toolFailureSummary,
  summarizeToolArgs,
  isExecutableScriptPath,
} from "../src/core/agent/tool-output";

describe("toolOutputCharLimit", () => {
  it("never truncates a tool that declares boundedOutput regardless of remaining budget", () => {
    // Near-full context (remaining 2245 of 24577): a bounded read tool must
    // NOT be cut to ~2K chars — the model then believes files are truncated
    // and loops re-reading them (ses_mssx0k11).
    expect(toolOutputCharLimit(2245, 24577, true)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("still truncates unbounded tools by budget", () => {
    const limit = toolOutputCharLimit(2245, 24577, false);
    expect(limit).toBeLessThan(24577 * 0.3 * 2);
    expect(limit).toBeGreaterThan(0);
  });
});

describe("compactToolError", () => {
  it("returns only the first non-empty line", () => {
    const output = "Error: file not found\n\nHint: run list_dir first\nDo NOT retry.";
    expect(compactToolError(output)).toBe("Error: file not found");
  });

  it("skips leading blank lines", () => {
    expect(compactToolError("\n\n  boom  \ntail")).toBe("boom");
  });

  it("truncates long lines", () => {
    const out = compactToolError("x".repeat(500), 40);
    expect(out.length).toBe(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for empty/nullish output", () => {
    expect(compactToolError("")).toBe("");
    expect(compactToolError(undefined)).toBe("");
    expect(compactToolError("\n  \n")).toBe("");
  });
});

describe("toolFailureSummary", () => {
  it("maps a security block to a calm warning without the raw marker", () => {
    const out = toolFailureSummary("[SECURITY BLOCKED] Command is not allowed: rm -rf\nHint: ...");
    expect(out.severity).toBe("warn");
    expect(out.text).not.toContain("[SECURITY BLOCKED]");
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("maps a protected-path refusal to a warning", () => {
    const out = toolFailureSummary('[PROTECTED PATH] Protected path ".env" (matches .env*). Do NOT modify it.');
    expect(out.severity).toBe("warn");
    expect(out.text).not.toContain("[PROTECTED PATH]");
  });

  it("keeps a real failure as an error and returns the first line", () => {
    const out = toolFailureSummary("Error: file not found\nHint: run list_dir first");
    expect(out.severity).toBe("error");
    expect(out.text).toBe("Error: file not found");
  });
});

describe("summarizeToolArgs", () => {
  it("keeps short scalar args", () => {
    const out = summarizeToolArgs({ path: "src/a.ts", command: "bun test" });
    expect(out).toContain("path:src/a.ts");
    expect(out).toContain("command:bun test");
  });

  it("collapses long string values instead of echoing the body", () => {
    const out = summarizeToolArgs({ path: "src/a.ts", content: "x".repeat(5000) });
    expect(out).toContain("path:src/a.ts");
    expect(out).toContain("content:…(5000 chars)");
    expect(out).not.toContain("x".repeat(100));
  });

  it("returns empty for nullish/empty args", () => {
    expect(summarizeToolArgs(undefined)).toBe("");
    expect(summarizeToolArgs(null)).toBe("");
    expect(summarizeToolArgs({})).toBe("");
  });
});

describe("isExecutableScriptPath", () => {
  it("flags wrapper-script extensions", () => {
    expect(isExecutableScriptPath("run.bat")).toBe(true);
    expect(isExecutableScriptPath("C:/x/setup.CMD")).toBe(true);
    expect(isExecutableScriptPath("deploy.sh")).toBe(true);
    expect(isExecutableScriptPath("a.ps1")).toBe(true);
  });

  it("does not flag regular source/config files", () => {
    expect(isExecutableScriptPath("src/a.ts")).toBe(false);
    expect(isExecutableScriptPath("package.json")).toBe(false);
    expect(isExecutableScriptPath("README.md")).toBe(false);
  });
});
