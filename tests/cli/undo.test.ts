import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../../src/cli/commands";
import { DEFAULTS } from "../../src/config/defaults";
import type { AppConfig } from "../../src/config/types";
import { setLocale, t } from "../../src/i18n/index";
import { runUndo, type UndoRuntime } from "../../src/cli/undo-command";
import { ChangesStore } from "../../src/modules/changes/store";
import type { SessionLogEntry } from "../../src/modules/session/log-types";
import type { SessionManager } from "../../src/modules/session/index";
import type { UndoResult } from "../../src/modules/changes/types";
import { localizeOutput } from "../../src/tools/restore-file";

interface UndoHarness {
  root: string;
  runtime: UndoRuntime;
  store: ChangesStore;
  logs: Array<{ entry: SessionLogEntry; sessionId?: string | null }>;
}

/** Живой журнал правок + шпион `appendLog` вместо тяжёлого `bootstrap()`. */
function harness(): UndoHarness {
  const root = mkdtempSync(join(tmpdir(), "mma-cli-undo-"));
  const config = structuredClone(DEFAULTS) as AppConfig;
  const dir = (id: string) => join(root, "sessions", id);
  mkdirSync(dir("s1"), { recursive: true });
  const logs: UndoHarness["logs"] = [];
  const sessionManager = {
    getSessionDirectory: dir,
    appendLog: (entry: SessionLogEntry, sessionId?: string | null) => {
      logs.push({ entry, sessionId });
    },
  } as unknown as SessionManager;
  return {
    root,
    runtime: { sessionManager, config, baseDir: root },
    store: new ChangesStore({ sessionManager: { getSessionDirectory: dir }, getConfig: () => config }),
    logs,
  };
}

function seedWrite(h: UndoHarness, before: string, after: string): void {
  const beforeHash = h.store.putBlob("s1", Buffer.from(before));
  const afterHash = h.store.putBlob("s1", Buffer.from(after));
  writeFileSync(join(h.root, "a.txt"), after);
  h.store.append("s1", {
    v: 1,
    id: "e1",
    ts: new Date().toISOString(),
    turn: 1,
    tool: "write_file",
    callId: "c1",
    op: "write",
    path: "a.txt",
    pathAbs: join(h.root, "a.txt"),
    before: beforeHash,
    after: afterHash,
    bytes: Buffer.byteLength(after),
  });
}

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

  it("emits a typed change event into the explicit session on CLI-driven undo", async () => {
    const h = harness();
    try {
      seedWrite(h, "old", "new");
      const out: string[] = [];
      await runUndo(["a.txt", "--session", "s1"], (line) => out.push(line), h.runtime);

      expect(out.join("\n")).toContain(
        t("changes.result_ok", { detail: `a.txt: ${t("changes.reason.restored")}` }),
      );
      expect(readFileSync(join(h.root, "a.txt"), "utf8")).toBe("old");
      const changes = h.logs.filter((l) => l.entry.type === "change");
      expect(changes).toHaveLength(1);
      expect(changes[0]!.entry).toMatchObject({
        type: "change",
        source: "module:changes",
        module: "changes",
        operation: "changes.undo",
        path: "a.txt",
        op: "write",
        targetId: "e1",
        tool: "write_file",
      });
      expect(changes[0]!.sessionId).toBe("s1");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });

  it("does not emit a change event for --list (no undo performed)", async () => {
    const h = harness();
    try {
      seedWrite(h, "old", "new");
      const out: string[] = [];
      await runUndo(["--list", "--session", "s1"], (line) => out.push(line), h.runtime);

      expect(out.join("\n")).toContain("e1");
      expect(h.logs).toHaveLength(0);
      expect(readFileSync(join(h.root, "a.txt"), "utf8")).toBe("new");
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
});
