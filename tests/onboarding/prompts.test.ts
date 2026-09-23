import { describe, it, expect } from "vitest";
import { MEET_SYSTEM_PROMPT, INIT_SYSTEM_PROMPT, MEET_TOOLS, INIT_TOOLS } from "../../src/modules/onboarding/prompts";

describe("onboarding prompts", () => {
  it("meet prompt covers domain first and the whitelist", () => {
    expect(MEET_SYSTEM_PROMPT).toContain("domain");
    for (const key of ["name", "language", "response_style", "autonomy"]) {
      expect(MEET_SYSTEM_PROMPT).toContain(key);
    }
    expect(MEET_SYSTEM_PROMPT).not.toMatch(/programmer|software engineer/i);
  });

  it("meet tool list is restricted", () => {
    expect(MEET_TOOLS).toEqual(["remember", "question", "meet_done"]);
  });

  it("init prompt is workspace-neutral", () => {
    expect(INIT_SYSTEM_PROMPT).toContain("AGENTS.md");
    expect(INIT_SYSTEM_PROMPT).not.toMatch(/git repository is required/i);
  });

  it("init tool list excludes bash", () => {
    expect(INIT_TOOLS).not.toContain("bash");
    expect(INIT_TOOLS).toContain("write_file");
  });
});
