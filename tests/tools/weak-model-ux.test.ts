// Phase 4: structured errors (errorMeta), fuzzy skills, empty-input safety.
import { describe, it, expect } from "vitest";
import { appendErrorMeta, compactToolError } from "../../src/core/agent/tool-output";
import { nearestSkillNames, createLoadSkillTool } from "../../src/tools/load-skill";

describe("ToolResult.errorMeta", () => {
  it("appends a compact directive for the model", () => {
    const out = appendErrorMeta("Grep failed", {
      code: "grep_no_engine",
      retryable: true,
      hint: "set tools.grepEngine=auto",
    });
    expect(out).toContain("[error code=grep_no_engine retryable=true]");
    expect(out).toContain("set tools.grepEngine=auto");
  });

  it("does not leak errorMeta into the chat-facing compact error", () => {
    const result = {
      success: false,
      output: "Grep failed",
      errorMeta: { code: "grep_no_engine", retryable: true, hint: "secret model hint" },
    };
    const chat = compactToolError(result.output);
    expect(chat).toBe("Grep failed");
    expect(chat).not.toContain("grep_no_engine");
    expect(chat).not.toContain("secret model hint");
  });

  it("returns output unchanged when no meta", () => {
    expect(appendErrorMeta("plain", undefined)).toBe("plain");
  });
});

describe("nearestSkillNames", () => {
  it("suggests the closest names", () => {
    const names = ["css-styling-expert", "react-expert", "auth-expert"];
    expect(nearestSkillNames("css-expert", names)[0]).toBe("css-styling-expert");
  });
});

describe("load_skill fuzzy hint", () => {
  function fakeModule(names: string[]) {
    return {
      loadByName: () => ({ success: false, message: "Skill not found" }),
      getAvailable: () => names.map((name) => ({ name })),
      getBudget: () => ({ remaining: 0 }),
    } as any;
  }

  it("suggests near names on a miss and marks it retryable", async () => {
    const tool = createLoadSkillTool(fakeModule(["css-styling-expert", "react-expert"]));
    const res = await tool.handler!({} as any, { name: "css-expert" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("css-styling-expert");
    expect(res.errorMeta?.code).toBe("skill_not_found");
    expect(res.errorMeta?.retryable).toBe(true);
  });
});
