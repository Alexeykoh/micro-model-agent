import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { AppConfig } from "../../config/types";
import type { Diagnostic } from "../../output/types";
import { isInsideDir, safeResolvePath } from "../../tools/path-utils";
import type { ToolCall, ToolContext, ToolDefinition } from "../../tools/types";
import type { ChangesStore } from "./store";
import type { ChangeEntry, ChangeOp } from "./types";

/** File-mutating tools → journal operation and the arguments that hold paths. */
export const OP_BY_TOOL: Record<
  string,
  { op: ChangeOp; pathArg: string; toArg?: string }
> = {
  write_file: { op: "write", pathArg: "path" },
  edit_file: { op: "write", pathArg: "path" },
  patch_file: { op: "write", pathArg: "path" },
  append_file: { op: "write", pathArg: "path" },
  download_file: { op: "write", pathArg: "path" },
  delete_file: { op: "delete", pathArg: "path" },
  move_file: { op: "move", pathArg: "from", toArg: "to" },
};

/** Writers that carry pathArgs but are deliberately not snapshotted. */
export const EXCLUDED_TOOLS: Record<string, string> = {
  create_dir: "directory creation has no file content to snapshot",
  bash: "no pathArgs; shell mutations cannot be attributed reliably",
  restore_file: "undo writes are journaled as undo markers, not edit revisions",
};

type Plan = { op: ChangeOp; pathArg: string; toArg?: string };

interface Pending {
  sessionId: string;
  entry: Omit<ChangeEntry, "after" | "bytes">;
  afterPathAbs: string | null;
  toPathAbs: string | null;
  onDiagnostic?: (d: Diagnostic) => void;
}

const shaOf = (
  store: ChangesStore,
  sessionId: string,
  pathAbs: string | null,
): string | null => {
  if (!pathAbs || !existsSync(pathAbs)) return null;
  return store.putBlob(sessionId, readFileSync(pathAbs));
};

/**
 * Snapshots file content around a tool call. `before` captures the pre-state;
 * `after` commits the entry only on success. All failures are fail-open and
 * reported as diagnostics — nothing thrown escapes either method.
 */
export class ChangeCapture {
  private pending = new Map<string, Pending>();
  private readonly getConfig: () => AppConfig;

  constructor(
    private readonly store: ChangesStore,
    config: AppConfig | (() => AppConfig),
    private readonly onDiagnostic?: (d: Diagnostic) => void,
  ) {
    this.getConfig = typeof config === "function" ? config : () => config;
  }

  before(ctx: ToolContext, tool: ToolDefinition, call: ToolCall): void {
    try {
      const plan = OP_BY_TOOL[call.name] ?? OP_BY_TOOL[tool.name];
      if (
        !plan ||
        !ctx.sessionId ||
        this.getConfig().changes?.enabled === false
      ) {
        return;
      }
      const base = resolve(ctx.baseDir);
      const path = String(call.arguments[plan.pathArg] ?? "");
      if (!path) return;
      const pathAbs = safeResolvePath(base, path);
      if (!isInsideDir(pathAbs, base)) return;

      const link = lstatSync(pathAbs, { throwIfNoEntry: false });
      if (link?.isSymbolicLink()) {
        this.pending.set(call.id, {
          sessionId: ctx.sessionId,
          entry: this.skippedEntry(call, plan, path, pathAbs, "unsupported", base),
          afterPathAbs: null,
          toPathAbs: null,
          onDiagnostic: ctx.onDiagnostic,
        });
        return;
      }

      const stat = statSync(pathAbs, { throwIfNoEntry: false });
      const tooBig =
        !!stat &&
        stat.size > (this.getConfig().changes?.maxFileBytes ?? 2_097_152);
      if (tooBig) {
        this.pending.set(call.id, {
          sessionId: ctx.sessionId,
          entry: this.skippedEntry(call, plan, path, pathAbs, "too-large", base),
          afterPathAbs: null,
          toPathAbs: null,
          onDiagnostic: ctx.onDiagnostic,
        });
        return;
      }

      const before = stat ? shaOf(this.store, ctx.sessionId, pathAbs) : null;
      const mode = stat?.mode;
      const toPathAbs = plan.toArg
        ? safeResolvePath(base, String(call.arguments[plan.toArg] ?? ""))
        : null;
      if (toPathAbs && !isInsideDir(toPathAbs, base)) return;
      const toBefore =
        toPathAbs && existsSync(toPathAbs)
          ? shaOf(this.store, ctx.sessionId, toPathAbs)
          : null;

      this.pending.set(call.id, {
        sessionId: ctx.sessionId,
        entry: {
          ...this.baseEntry(call, plan.op, path, pathAbs, before, undefined),
          ...(mode !== undefined ? { mode } : {}),
          ...(plan.toArg && toPathAbs
            ? { to: relative(base, toPathAbs), toBefore }
            : {}),
        },
        afterPathAbs: plan.op === "delete" ? null : pathAbs,
        toPathAbs,
        onDiagnostic: ctx.onDiagnostic,
      });
    } catch (err) {
      this.report("changes.capture.before", err, ctx.onDiagnostic);
    }
  }

  after(callId: string, success: boolean): void {
    const p = this.pending.get(callId);
    this.pending.delete(callId);
    if (!p || !success) return;
    try {
      const sessionId = p.sessionId;
      const after = shaOf(this.store, sessionId, p.afterPathAbs);
      const bytes =
        p.afterPathAbs && existsSync(p.afterPathAbs)
          ? statSync(p.afterPathAbs).size
          : 0;
      this.store.append(sessionId, {
        ...p.entry,
        turn: this.store.loadTurn(sessionId) || 1,
        after,
        bytes,
      });
    } catch (err) {
      this.report("changes.capture.after", err, p.onDiagnostic);
    }
  }

  private baseEntry(
    call: ToolCall,
    op: ChangeOp,
    path: string,
    pathAbs: string,
    before: string | null,
    skipped: ChangeEntry["skipped"],
  ): Omit<ChangeEntry, "after" | "bytes"> {
    return {
      v: 1,
      id: `ch_${Date.now()}_${call.id}`,
      ts: new Date().toISOString(),
      turn: 0,
      tool: call.name,
      callId: call.id,
      op,
      path,
      pathAbs,
      before,
      ...(skipped ? { skipped } : {}),
    };
  }

  /** Keep skipped moves structurally valid (`to` is required by the journal). */
  private skippedEntry(
    call: ToolCall,
    plan: Plan,
    path: string,
    pathAbs: string,
    skipped: NonNullable<ChangeEntry["skipped"]>,
    base: string,
  ): Omit<ChangeEntry, "after" | "bytes"> {
    const entry = this.baseEntry(call, plan.op, path, pathAbs, null, skipped);
    if (plan.toArg) {
      const toPath = safeResolvePath(
        base,
        String(call.arguments[plan.toArg] ?? ""),
      );
      if (isInsideDir(toPath, base)) {
        return { ...entry, to: relative(base, toPath), toBefore: null };
      }
    }
    return entry;
  }

  private report(
    operation: string,
    err: unknown,
    sink?: (d: Diagnostic) => void,
  ): void {
    const diag: Diagnostic = {
      source: "module:changes",
      operation,
      kind: "failed",
      cause: err instanceof Error ? err.message : String(err),
      recoverable: true,
    };
    (sink ?? this.onDiagnostic)?.(diag);
  }
}
