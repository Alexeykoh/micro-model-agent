import { describe, it, expect } from "vitest";
import { runSearch, classifySearchError } from "../src/tools/grep-tool";

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

  it("runSearch rejects with the process exit status attached", async () => {
    await expect(
      runSearch(process.execPath, ["-e", "process.exit(2)"], process.cwd(), 30000),
    ).rejects.toMatchObject({ status: 2 });
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

describe("grep external engine failure classification", () => {
  it("treats a shell/spawn failure as engine-unavailable (falls through to JS)", () => {
    const notFound = new Error("'rg' is not recognized as an internal or external command");
    expect(classifySearchError(notFound)).toBeNull();
    const commandNotFound = new Error("rg: command not found");
    expect(classifySearchError(commandNotFound)).toBeNull();
  });

  it("still reports a genuine timeout as a failure", () => {
    const timeout = new Error("search timed out after 30000ms");
    const r = classifySearchError(timeout);
    expect(r?.success).toBe(false);
  });

  it("reports a genuine search-target error (exit 2) as a failure, not engine-unavailable", () => {
    const e: any = new Error("rg: /tmp/nope: No such file or directory (os error 2)");
    e.status = 2;
    const r = classifySearchError(e);
    expect(r?.success).toBe(false);
  });

  it("treats a cmd.exe shim exit code (255/9009) as engine-unavailable regardless of locale", () => {
    const localized: any = new Error('"bar" не является внутренней или внешней командой');
    localized.status = 255;
    expect(classifySearchError(localized)).toBeNull();
    const nineThousand: any = new Error("command not found");
    nineThousand.status = 9009;
    expect(classifySearchError(nineThousand)).toBeNull();
  });
});
