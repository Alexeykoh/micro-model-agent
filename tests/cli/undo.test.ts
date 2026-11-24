import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createProgram } from "../../src/cli/commands";
import { setLocale, t } from "../../src/i18n/index";
import { runUndo } from "../../src/cli/undo-command";

describe("mma undo", () => {
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale("en"));

  it("is registered with path/list/turn options", () => {
    const cmd = createProgram().commands.find((c) => c.name() === "undo");
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toContain("--steps");
    expect(flags).toContain("--force");
    expect(flags).toContain("--turn");
    expect(flags).toContain("--list");
  });

  it("rejects invalid args before bootstrapping a session", async () => {
    const capture = async (args: string[]): Promise<string[]> => {
      const lines: string[] = [];
      await runUndo(args, (line, stream) => lines.push(`${stream ?? "out"}:${line}`));
      return lines;
    };
    expect(await capture(["a.txt", "--steps", "0"])).toEqual([
      `stderr:${t("changes.invalid_steps")}`,
    ]);
    expect(await capture(["--turn", "abc"])).toEqual([
      `stderr:${t("changes.invalid_turn")}`,
    ]);
    expect(await capture(["a.txt", "--turn", "2"])).toEqual([
      `stderr:${t("changes.path_and_turn")}`,
    ]);
    expect(await capture(["--force"])).toEqual([
      `stderr:${t("changes.path_or_turn_required")}`,
    ]);
  });
});
