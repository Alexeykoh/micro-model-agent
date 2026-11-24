import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createProgram } from "../../src/cli/commands";
import { setLocale, t } from "../../src/i18n/index";
import { runUndo } from "../../src/cli/undo-command";
import type { UndoResult } from "../../src/modules/changes/types";
import { localizeOutput } from "../../src/tools/restore-file";

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

  it("parses an explicit --turn N and a bare --turn", () => {
    const cmd = createProgram().commands.find((c) => c.name() === "undo")!;
    cmd.parseOptions(["--turn", "3"]);
    expect(cmd.opts().turn).toBe("3");
    cmd.parseOptions(["--turn"]);
    expect(cmd.opts().turn).toBe(true);
  });

  it("rejects invalid args before bootstrapping a session", async () => {
    const capture = async (args: string[]): Promise<string[]> => {
      const lines: string[] = [];
      await runUndo(args, (line, stream) => lines.push(`${stream ?? "out"}:${line}`));
      return lines;
    };
    const invalidTurn = [`stderr:${t("changes.invalid_turn")}`];
    expect(await capture(["a.txt", "--steps", "0"])).toEqual([
      `stderr:${t("changes.invalid_steps")}`,
    ]);
    expect(await capture(["--turn"])).toEqual(invalidTurn);
    expect(await capture(["--turn", "0"])).toEqual(invalidTurn);
    expect(await capture(["--turn", "-2"])).toEqual(invalidTurn);
    expect(await capture(["--turn", "1.5"])).toEqual(invalidTurn);
    expect(await capture(["--turn", "abc"])).toEqual(invalidTurn);
    expect(await capture(["a.txt", "--turn", "2"])).toEqual([
      `stderr:${t("changes.path_and_turn")}`,
    ]);
    expect(await capture(["--force"])).toEqual([
      `stderr:${t("changes.path_or_turn_required")}`,
    ]);
  });

  it("localizes undo reasons in CLI output under ru", () => {
    setLocale("ru");
    const result: UndoResult = {
      ok: false,
      message: "file changed since the snapshot",
      items: [
        { path: "a.txt", ok: false, reason: "file changed since the snapshot" },
        {
          path: "b.txt",
          ok: false,
          reason: "snapshot for b.txt was evicted; no undoable version remains",
        },
        { path: "c.txt", ok: true },
      ],
    };
    const out = localizeOutput(result);
    expect(out).not.toContain("file changed since the snapshot");
    expect(out).not.toContain("no undoable version remains");
    expect(out).toContain(t("changes.reason.file_changed"));
    expect(out).toContain(t("changes.reason.evicted_file", { path: "b.txt" }));
    expect(out).toContain(t("changes.reason.restored"));

    const fallback = localizeOutput({
      ok: false,
      message: "not enough undo steps for this file",
      items: [],
    });
    expect(fallback).not.toContain("not enough undo steps for this file");
    expect(fallback).toContain(t("changes.reason.few_steps"));
  });
});
