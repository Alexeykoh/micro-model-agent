import { describe, it, expect } from "vitest";
import { buildSystemInfo } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";
import { fallbackPromptFacts } from "../../src/core/prompt-facts";
import type { PromptEnvironmentFacts } from "../../src/core/prompt-facts";

function facts(overrides: Partial<PromptEnvironmentFacts> = {}): PromptEnvironmentFacts {
  const base = fallbackPromptFacts(structuredClone(DEFAULTS), "/tmp/proj", "linux");
  return { ...base, ...overrides };
}

function prompt(overrides: Partial<PromptEnvironmentFacts> = {}): string {
  return buildSystemInfo(structuredClone(DEFAULTS), "/tmp/proj", "linux", facts(overrides));
}

describe("system prompt: environment facts", () => {
  it("does not claim Bun when bun is missing from PATH", () => {
    const text = prompt({ tools: { bun: "missing", git: "unknown", python: "unknown" } });
    expect(text).not.toContain("Bun is available");
    expect(text).toContain("do not assume Bun");
  });

  it("does not claim Bun for a non-Bun project", () => {
    const base = facts();
    const text = prompt({
      tools: { ...base.tools, bun: "present" },
      project: { ...base.project, packageManager: "npm" },
    });
    expect(text).not.toContain("Bun is available");
    expect(text).toContain("not a Bun project");
  });

  it("mentions Bun only for a Bun project with bun in PATH", () => {
    const base = facts();
    const text = prompt({
      tools: { ...base.tools, bun: "present" },
      project: { ...base.project, packageManager: "bun", testCommand: "bun test" },
    });
    expect(text).toContain("Bun is available");
    expect(text).toContain("bun test");
  });

  it("uses cmd.exe notes only for the cmd shell", () => {
    expect(prompt({ platform: "linux", shell: "sh" })).not.toContain("cmd.exe");
    expect(prompt({ platform: "win32", shell: "cmd" })).toContain("cmd.exe");
  });

  it("drops the plan section when autoPlan is off", () => {
    const off = prompt({ autoPlan: false });
    expect(off).not.toContain("PLAN QUALITY");
    expect(off).not.toContain("plan_step");
    const on = prompt({ autoPlan: true });
    expect(on).toContain("PLAN QUALITY");
    expect(on).toContain("plan_step");
  });

  it("does not promise lsp_check when LSP is disabled", () => {
    const base = facts();
    expect(prompt({ lsp: { ...base.lsp, enabled: false } })).not.toContain("lsp_check");
    expect(prompt({ lsp: { ...base.lsp, enabled: true } })).toContain("lsp_check");
  });

  it("does not promise approve for protected paths", () => {
    const text = prompt();
    expect(text).not.toContain("approve");
    expect(text).toContain("ask the user to change the path");
  });

  it("does not duplicate the MCP availability claim in the static block", () => {
    const text = prompt();
    expect(text).not.toContain("MCP servers are available");
  });

  it("renders local time with an explicit offset", () => {
    expect(prompt()).toMatch(/Date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}/);
  });
});
