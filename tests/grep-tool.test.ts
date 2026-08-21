import { describe, it, expect } from "vitest";
import { runSearch } from "../src/tools/grep-tool";
import { join } from "path";

describe("grep async runSearch", () => {
  it("returns matching output", async () => {
    const out = await runSearch("grep", ["-rn", "export"], process.cwd(), 30000);
    expect(typeof out).toBe("string");
  });

  it("resolves empty string on exit code 1 (no matches)", async () => {
    const out = await runSearch("grep", ["-rn", "ZZZ_NO_MATCH_ZZZ", join(process.cwd(), "package.json")], process.cwd(), 30000);
    expect(out).toBe("");
  });

  it("kills the process on timeout and rejects", async () => {
    let msg = "";
    try {
      await runSearch("sleep", ["5"], process.cwd(), 200);
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toMatch(/timed out/i);
  }, 10000);
});
