import { describe, it, expect } from "vitest";
import { runSearch } from "../src/tools/grep-tool";

/**
 * Platform-independent runner: `grep` and `sleep` do not exist in a default
 * Windows PATH, so all cases go through the JS runtime executable (bun or
 * node), both of which support `-e <script>`.
 */
const RUNNER = process.execPath;

describe("grep async runSearch", () => {
  it("returns matching output", async () => {
    const out = await runSearch(
      RUNNER,
      ["-e", 'process.stdout.write("export const x = 1")'],
      process.cwd(),
      30000,
    );
    expect(typeof out).toBe("string");
    expect(out).toContain("export");
  });

  it("resolves empty string on exit code 1 (no matches)", async () => {
    const out = await runSearch(RUNNER, ["-e", "process.exit(1)"], process.cwd(), 30000);
    expect(out).toBe("");
  });

  it("kills the process on timeout and rejects", async () => {
    let msg = "";
    try {
      await runSearch(RUNNER, ["-e", "setTimeout(() => {}, 5000)"], process.cwd(), 200);
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toMatch(/timed out/i);
  }, 10000);
});
