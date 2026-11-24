import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { setLocale, t } from "../../src/i18n/index";
import {
  clearAuditSessionDir,
  setAuditSessionDir,
} from "../../src/modules/security/audit-log";
import type {
  ChangeEntry,
  ListOptions,
  UndoOptions,
  UndoResult,
} from "../../src/modules/changes/types";
import type { FileChangesPort } from "../../src/tools/file-changes-port";
import { listFileChangesTool, restoreFileTool } from "../../src/tools/index";

const SESSION = "changes-tools-test";
const auditDir = mkdtempSync(join(tmpdir(), "mma-changes-tools-"));
setAuditSessionDir(auditDir, SESSION);

afterEach(() => setLocale("en"));
afterAll(() => {
  clearAuditSessionDir(SESSION);
  rmSync(auditDir, { recursive: true, force: true });
});

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    baseDir: process.cwd(),
    config: { security: { paths: { enabled: false } } },
    logger: {} as never,
    activeCallId: "call-1",
    ...overrides,
  } as never;
}

function portWith(overrides: Partial<FileChangesPort> = {}): FileChangesPort {
  return {
    beginTurn() {},
    captureBefore() {},
    captureAfter() {},
    cancel() {},
    clear() {},
    list: () => [],
    undo: () => ({ ok: true, message: "", items: [] }),
    ...overrides,
  } as FileChangesPort;
}

function changeEntry(): ChangeEntry {
  return {
    v: 1,
    id: "ch1",
    ts: new Date().toISOString(),
    turn: 2,
    tool: "write_file",
    callId: "call-1",
    op: "write",
    path: "a.txt",
    pathAbs: join(process.cwd(), "a.txt"),
    before: null,
    after: "a".repeat(64),
    bytes: 1,
  };
}

describe("changes tools", () => {
  it("declares write capability and a path argument for restore, no alwaysOn", () => {
    expect(restoreFileTool.security).toEqual({ caps: [{ fs: "write" }], pathArgs: ["path"] });
    expect(restoreFileTool.alwaysOn).toBeUndefined();
    expect(restoreFileTool.tags).toEqual(["file"]);
    expect(listFileChangesTool.security.caps).toEqual([{ fs: "read" }]);
    expect(listFileChangesTool.alwaysOn).toBeUndefined();
    expect(listFileChangesTool.tags).toEqual(["file"]);
  });

  it("returns a readable message when no session is attached", async () => {
    const ctx = {
      sessionId: undefined, baseDir: process.cwd(), config: {}, logger: {} as never,
    } as never;
    const res = await restoreFileTool.handler(ctx, { path: "a.txt" });
    expect(res.success).toBe(false);
    expect(res.output).toContain("session");
  });

  it("refuses restore with neither path nor turn without touching the port", async () => {
    let calls = 0;
    const port = portWith({
      undo: () => {
        calls += 1;
        return { ok: true, message: "", items: [] };
      },
    });
    setLocale("ru");
    const res = await restoreFileTool.handler(makeCtx({ fileChanges: port }), {});
    expect(res.success).toBe(false);
    expect(res.output).toBe(t("changes.path_or_turn_required"));
    expect(res.output).toContain("Неявного текущего хода нет");
    expect(calls).toBe(0);
  });

  it("rejects path+turn together and invalid numeric arguments", async () => {
    let calls = 0;
    const port = portWith({
      undo: () => {
        calls += 1;
        return { ok: true, message: "", items: [] };
      },
    });
    const ctx = makeCtx({ fileChanges: port });
    expect((await restoreFileTool.handler(ctx, { path: "a.txt", turn: 2 })).output).toBe(
      t("changes.path_and_turn"),
    );
    expect((await restoreFileTool.handler(ctx, { path: "a.txt", steps: 0 })).output).toBe(
      t("changes.invalid_steps"),
    );
    expect((await restoreFileTool.handler(ctx, { turn: Number.NaN })).output).toBe(
      t("changes.invalid_turn"),
    );
    expect((await listFileChangesTool.handler(ctx, { limit: 0 })).output).toBe(
      t("changes.invalid_limit"),
    );
    expect(calls).toBe(0);
  });

  it("maps list arguments, localizes empty result and the turn label", async () => {
    let got: ListOptions | undefined;
    const port = portWith({
      list: (options) => {
        got = options;
        return [];
      },
    });
    const res = await listFileChangesTool.handler(makeCtx({ fileChanges: port }), {
      path: "a.txt",
      limit: 7,
    });
    expect(got).toEqual({
      sessionId: SESSION,
      baseDir: process.cwd(),
      path: "a.txt",
      limit: 7,
    });
    expect(res.output).toBe(t("changes.empty"));

    setLocale("ru");
    const listed = await listFileChangesTool.handler(
      makeCtx({ fileChanges: portWith({ list: () => [changeEntry()] }) }),
      {},
    );
    expect(listed.output).toContain(t("changes.list.turn", { turn: "2" }));
    expect(listed.output).not.toContain("turn 2");
  });

  it("maps undo arguments including authorize and passes the diff through", async () => {
    let got: UndoOptions | undefined;
    const port = portWith({
      undo: (options) => {
        got = options;
        return {
          ok: true,
          message: "a.txt: restored",
          items: [{ path: "a.txt", ok: true }],
          diff: "DIFF",
        };
      },
    });
    const res = await restoreFileTool.handler(makeCtx({ fileChanges: port }), {
      path: "a.txt",
      steps: 2,
      force: true,
    });
    expect(got).toEqual({
      sessionId: SESSION,
      baseDir: process.cwd(),
      path: "a.txt",
      steps: 2,
      turn: undefined,
      force: true,
      authorize: expect.any(Function),
    });
    expect(got?.authorize?.("a.txt")).toBeNull();
    expect(res.diff).toBe("DIFF");
    expect(res.output).toBe(t("changes.result_ok", { detail: "a.txt: restored" }));
  });

  it("gives undo an authorize callback that blocks protected paths in turn mode", async () => {
    let got: UndoOptions | undefined;
    const port = portWith({
      undo: (options) => {
        got = options;
        const denial = options.authorize?.(".env") ?? null;
        return {
          ok: false,
          message: ".env: skipped",
          items: [{ path: ".env", ok: false, reason: denial ?? "unknown" }],
        };
      },
    });
    const res = await restoreFileTool.handler(makeCtx({ fileChanges: port }), { turn: 3 });
    expect(got?.turn).toBe(3);
    expect(got?.path).toBeUndefined();
    expect(got?.authorize).toBeTypeOf("function");
    expect(got?.authorize?.(".env")).toContain(".env");
    expect(res.success).toBe(false);
    expect(res.output).toContain(".env");
  });

  it("localizes undo reasons and top-level failures under ru without English leaks", async () => {
    const failed: UndoResult = {
      ok: false,
      message: "a.txt: skipped (file changed since the snapshot)",
      items: [
        { path: "a.txt", ok: false, reason: "file changed since the snapshot" },
        { path: "b.txt", ok: false, reason: "path is outside the base directory" },
        { path: "c.txt", ok: true },
      ],
    };
    setLocale("ru");
    const res = await restoreFileTool.handler(
      makeCtx({ fileChanges: portWith({ undo: () => failed }) }),
      { path: "a.txt" },
    );
    expect(res.output).toContain(t("changes.reason.file_changed"));
    expect(res.output).toContain(t("changes.reason.outside_base"));
    expect(res.output).toContain(t("changes.reason.restored"));
    expect(res.output).not.toContain("file changed since the snapshot");
    expect(res.output).not.toContain("path is outside the base directory");
    expect(res.output).not.toContain("restored");
    expect(res.output).not.toContain("skipped (");

    const top = await restoreFileTool.handler(
      makeCtx({
        fileChanges: portWith({
          undo: () => ({
            ok: false,
            message: "invalid steps: expected a positive integer",
            items: [],
          }),
        }),
      }),
      { path: "a.txt" },
    );
    expect(top.output).toContain(t("changes.reason.invalid_steps"));
    expect(top.output).not.toContain("invalid steps: expected a positive integer");
  });
});
