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

  it("meet prompt routes closed questions to the question tool and enumerates autonomy", () => {
    expect(MEET_SYSTEM_PROMPT).toContain("question");
    expect(MEET_SYSTEM_PROMPT).toMatch(/autonomy=ask\|act/);
    expect(MEET_SYSTEM_PROMPT).toContain("response_style=concise|balanced|detailed");
  });

  it("meet tool list is restricted", () => {
    expect(MEET_TOOLS).toEqual(["remember", "question", "meet_done"]);
  });

  it("init prompt is workspace-neutral and guards AGENTS.md authoring", () => {
    expect(INIT_SYSTEM_PROMPT).toContain("AGENTS.md");
    expect(INIT_SYSTEM_PROMPT).toMatch(/improve it in place/i);
    expect(INIT_SYSTEM_PROMPT).toMatch(/confirm/i);
    expect(INIT_SYSTEM_PROMPT).toMatch(/do not run shell commands/i);
  });

  it("init tool list is exact and ordered", () => {
    expect(INIT_TOOLS).toEqual([
      "read_file",
      "list_dir",
      "glob",
      "grep",
      "project_map",
      "question",
      "write_file",
      "edit_file",
    ]);
  });
});
