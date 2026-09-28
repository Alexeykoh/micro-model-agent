import { describe, it, expect, vi } from "vitest";
import {
  CRITIC_READONLY_TOOLS,
  MAX_CRITIC_CHECKS,
  isAllowedCriticTool,
  parseChecks,
  runCriticChecks,
  renderCheckResults,
} from "../src/modules/critic/tools";

describe("critic read-only tools (Phase 2)", () => {
  it("excludes writes, shell, web and memory", () => {
    for (const t of CRITIC_READONLY_TOOLS) expect(isAllowedCriticTool(t)).toBe(true);
    for (const t of ["write_file", "edit_file", "delete_file", "bash", "web_search", "remember", "enable_tools"]) {
      expect(isAllowedCriticTool(t)).toBe(false);
    }
  });

  it("parseChecks drops disallowed tools, bad args and caps at MAX_CRITIC_CHECKS", () => {
    const verdict = {
      status: "concern" as const,
      summary: "s",
      issues: [],
      checks: [
        { tool: "read_file", args: { path: "a.ts" } },
        { tool: "bash", args: { command: "rm -rf /" } },
        { tool: "grep", args: "not-an-object" },
        { tool: "", args: {} },
        { tool: "glob", args: { pattern: "**/*.ts" } },
        { tool: "list_dir", args: { path: "." } },
        { tool: "file_info", args: { path: "x" } },
      ],
    };
    const checks = parseChecks(verdict);
    expect(checks.length).toBeLessThanOrEqual(MAX_CRITIC_CHECKS);
    expect(checks.map((c) => c.tool)).toEqual(["read_file", "glob", "list_dir"]);
    expect(checks.every((c) => isAllowedCriticTool(c.tool))).toBe(true);
  });

  it("parseChecks returns [] without a checks array", () => {
    expect(parseChecks(null)).toEqual([]);
    expect(parseChecks({ status: "ok", summary: "", issues: [] })).toEqual([]);
  });

  it("runCriticChecks executes sequentially and isolates failures", async () => {
    const runCheck = vi.fn(async (tool: string) => {
      if (tool === "grep") throw new Error("boom");
      return { ok: true, output: `${tool} output` };
    });
    const results = await runCriticChecks(
      [
        { tool: "read_file", args: { path: "a" } },
        { tool: "grep", args: { pattern: "x" } },
      ],
      runCheck,
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ tool: "read_file", ok: true });
    expect(results[1]).toMatchObject({ tool: "grep", ok: false });
    expect(results[1].output).toContain("boom");
    expect(runCheck).toHaveBeenCalledTimes(2);
  });

  it("runCriticChecks truncates long outputs", async () => {
    const results = await runCriticChecks(
      [{ tool: "read_file", args: { path: "a" } }],
      async () => ({ ok: true, output: "x".repeat(100000) }),
    );
    expect(results[0].output.length).toBeLessThanOrEqual(1500);
  });

  it("renderCheckResults marks ok/fail", () => {
    const text = renderCheckResults([
      { tool: "read_file", ok: true, output: "content" },
      { tool: "grep", ok: false, output: "nope" },
    ]);
    expect(text).toContain("✓ read_file");
    expect(text).toContain("✗ grep");
  });
});
