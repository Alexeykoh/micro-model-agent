import { describe, it, expect } from "vitest";
import { buildEvidencePack, isWorkMutation } from "../src/modules/critic/evidence";

describe("critic evidence", () => {
  it("detects work mutations", () => {
    expect(isWorkMutation("write_file")).toBe(true);
    expect(isWorkMutation("edit_file")).toBe(true);
    expect(isWorkMutation("bash")).toBe(true);
    expect(isWorkMutation("read_file")).toBe(false);
    expect(isWorkMutation("plan")).toBe(false);
  });

  it("collects changed files, commands and a bounded digest", () => {
    const pack = buildEvidencePack({
      task: "fix bug",
      planSummary: "step 1 -> done",
      toolEvents: [
        { tool: "write_file", args: { path: "src/a.ts" }, ok: true },
        { tool: "bash", args: { command: "bun test" }, ok: false },
        { tool: "read_file", args: { path: "src/a.ts" }, ok: true },
      ],
    });
    expect(pack.changedFiles).toContain("src/a.ts");
    expect(pack.commands[0]).toEqual({ command: "bun test", exitCode: 1 });
    expect(pack.toolDigest.split("\n")).toHaveLength(3);
  });
});
