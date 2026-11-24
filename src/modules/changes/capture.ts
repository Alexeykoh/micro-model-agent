import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DEFAULTS } from "../../config/defaults";
import type { AppConfig } from "../../config/types";
import type { Diagnostic } from "../../output/types";
import { isInsideDir, safeResolvePath } from "../../tools/path-utils";
import type { ToolCall, ToolContext, ToolDefinition } from "../../tools/types";
import type { ChangesStore } from "./store";
import type { ChangeEntry, ChangeOp } from "./types";

/** In-flight snapshot cap; the oldest is evicted with a diagnostic. */
export const MAX_PENDING = 1000;

type Plan = { op: ChangeOp; pathArg: string; toArg?: string };
type Target = { toPathAbs: string; to: string };
type Sink = (d: Diagnostic) => void;
type Detail = Record<string, unknown>;

/** File-mutating tools → journal operation and the arguments holding paths. */
export const OP_BY_TOOL: Record<string, Plan> = {
  write_file: { op: "write", pathArg: "path" },
  edit_file: { op: "write", pathArg: "path" },
  patch_file: { op: "write", pathArg: "path" },
  append_file: { op: "write", pathArg: "path" },
  download_file: { op: "write", pathArg: "path" },
  delete_file: { op: "delete", pathArg: "path" },
  move_file: { op: "move", pathArg: "from", toArg: "to" },
};

/** Writers with pathArgs that are deliberately not snapshotted. */
export const EXCLUDED_TOOLS: Record<string, string> = {
  create_dir: "directory creation has no file content to snapshot",
  bash: "no pathArgs; shell mutations cannot be attributed reliably",
  restore_file: "undo writes are journaled as undo markers, not edit revisions",
};

interface Pending {
  sessionId: string;
  entry: Omit<ChangeEntry, "after" | "bytes">;
  guardPaths: string[];
  pathGuard?: ToolContext["pathGuard"];
  base: string;
  afterPathAbs: string | null;
  toPathAbs: string | null;
  sink?: Sink;
}

const message = (err: unknown): string => err instanceof Error ? err.message : String(err);
const maxBytes = (c: AppConfig): number => c.changes?.maxFileBytes ?? DEFAULTS.changes!.maxFileBytes!;
const shaOf = (store: ChangesStore, sid: string, p: string | null): string | null =>
  !p || !existsSync(p) ? null : store.putBlob(sid, readFileSync(p));

/** Reason a path is unsafe to read, or null when still contained (lstat + realpath). */
const escapeCause = (base: string, target: string): string | null => {
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return "path is a symbolic link";
  let realBase: string;
  try { realBase = realpathSync(base); } catch { return null; } // virtual base
  let probe = target;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return real === realBase || isInsideDir(real, realBase) ? null : "path resolves outside the base directory";
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
};

/** A move destination, or a cause making the move unsafe to journal at all. */
const moveTarget = (base: string, call: ToolCall, plan: Plan): Target | { cause: string } => {
  if (!plan.toArg) return { cause: "move has no destination argument" };
  const raw = String(call.arguments[plan.toArg] ?? "");
  if (!raw) return { cause: "move destination is empty" };
  const toPathAbs = safeResolvePath(base, raw);
  if (!isInsideDir(toPathAbs, base)) return { cause: "move destination is outside the base directory" };
  const to = relative(base, toPathAbs);
  if (!to) return { cause: "move destination resolves to the base directory" };
  const unsafe = escapeCause(base, toPathAbs);
  return unsafe ? { cause: `move destination ${unsafe}` } : { toPathAbs, to };
};

/**
 * Snapshots file content around a tool call. `before` captures the pre-state;
 * `after` commits only on success and re-validates paths (TOCTOU). Failures are
 * fail-open: a diagnostic is emitted, nothing is thrown out.
 */
export class ChangeCapture {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly store: ChangesStore,
    private readonly getConfig: () => AppConfig,
    private readonly onDiagnostic?: Sink,
  ) {}

  /** Drop one in-flight snapshot (executor early-return/abort, Task 5). */
  cancel(callId: string): void { this.pending.delete(callId); }

  /** Drop every in-flight snapshot (session teardown). */
  clear(): void { this.pending.clear(); }

  before(ctx: ToolContext, _tool: ToolDefinition, call: ToolCall): void {
    const detail: Detail = { callId: call.id, sessionId: ctx.sessionId, path: "", call: call.name };
    const sink = ctx.onDiagnostic;
    try {
      const plan = OP_BY_TOOL[call.name];
      if (!plan || !ctx.sessionId || this.getConfig().changes?.enabled === false) return;
      const base = resolve(ctx.baseDir);
      const path = String(call.arguments[plan.pathArg] ?? "");
      detail.path = path;
      if (!path) return;
      const pathAbs = safeResolvePath(base, path);
      if (!isInsideDir(pathAbs, base)) return;

      // An unusable move destination is never journaled — not even as skipped.
      const target = plan.toArg ? moveTarget(base, call, plan) : null;
      if (target && "cause" in target) {
        this.emit("changes.capture.before", "skipped", target.cause, sink, detail);
        return;
      }
      const unsafe = escapeCause(base, pathAbs);
      if (unsafe) {
        this.add(call.id, this.forCall(ctx, call, plan, path, pathAbs, base, target, null, "unsupported"), detail, sink);
        this.emit("changes.capture.before", "skipped", `source ${unsafe}; snapshot skipped`, sink, detail);
        return;
      }
      const stat = statSync(pathAbs, { throwIfNoEntry: false });
      if (stat && stat.size > maxBytes(this.getConfig())) {
        this.add(call.id, this.forCall(ctx, call, plan, path, pathAbs, base, target, null, "too-large"), detail, sink);
        this.emit("changes.capture.before", "skipped", "source exceeds changes.maxFileBytes; snapshot skipped", sink, detail);
        return;
      }
      const before = stat ? shaOf(this.store, ctx.sessionId, pathAbs) : null;
      this.add(call.id, this.forCall(ctx, call, plan, path, pathAbs, base, target, before, undefined), detail, sink);
    } catch (err) {
      this.emit("changes.capture.before", "failed", message(err), sink, detail);
    }
  }

  after(callId: string, success: boolean): void {
    const p = this.pending.get(callId);
    this.pending.delete(callId);
    if (!p || !success) return;
    const detail: Detail = { callId, sessionId: p.sessionId, path: p.entry.path, call: p.entry.tool };
    try {
      for (const guarded of p.guardPaths) {
        if (p.pathGuard?.recheck(guarded)) {
          this.emit("changes.capture.after", "skipped", "path guard blocked the snapshot in after()", p.sink, detail);
          return;
        }
      }
      if (p.afterPathAbs) {
        const unsafe = escapeCause(p.base, p.afterPathAbs);
        if (unsafe) {
          this.emit("changes.capture.after", "skipped", `source ${unsafe}; snapshot skipped`, p.sink, detail);
          return;
        }
      }
      if (p.toPathAbs) {
        const unsafe = escapeCause(p.base, p.toPathAbs);
        if (unsafe) {
          this.emit("changes.capture.after", "skipped", `move destination ${unsafe}; snapshot skipped`, p.sink, detail);
          return;
        }
      }
      const after = shaOf(this.store, p.sessionId, p.afterPathAbs);
      const bytes = p.afterPathAbs && existsSync(p.afterPathAbs) ? statSync(p.afterPathAbs).size : 0;
      this.store.append(p.sessionId, { ...p.entry, turn: this.store.loadTurn(p.sessionId) || 1, after, bytes });
    } catch (err) {
      this.emit("changes.capture.after", "failed", message(err), p.sink, detail);
    }
  }

  private baseEntry(call: ToolCall, op: ChangeOp, path: string, abs: string, before: string | null, skipped: ChangeEntry["skipped"]): Omit<ChangeEntry, "after" | "bytes"> {
    return { v: 1, id: `ch_${Date.now()}_${call.id}`, ts: new Date().toISOString(), turn: 0, tool: call.name, callId: call.id, op, path, pathAbs: abs, before, ...(skipped ? { skipped } : {}) };
  }

  private forCall(ctx: ToolContext, call: ToolCall, plan: Plan, path: string, abs: string, base: string, target: Target | { cause: string } | null, before: string | null, skipped: ChangeEntry["skipped"]): Pending {
    const toBefore = target && "toPathAbs" in target && existsSync(target.toPathAbs) ? shaOf(this.store, ctx.sessionId!, target.toPathAbs) : null;
    const mode = skipped ? undefined : statSync(abs, { throwIfNoEntry: false })?.mode;
    const toRaw = plan.toArg ? String(call.arguments[plan.toArg] ?? "") : "";
    return {
      sessionId: ctx.sessionId!,
      entry: { ...this.baseEntry(call, plan.op, path, abs, before, skipped), ...(mode !== undefined ? { mode } : {}), ...(target && "to" in target ? { to: target.to, toBefore } : {}) },
      guardPaths: toRaw ? [path, toRaw] : [path],
      pathGuard: ctx.pathGuard,
      base,
      afterPathAbs: !skipped && plan.op !== "delete" ? abs : null,
      toPathAbs: target && "toPathAbs" in target ? target.toPathAbs : null,
      sink: ctx.onDiagnostic,
    };
  }

  private add(callId: string, pending: Pending, detail: Detail, sink?: Sink): void {
    if (this.pending.has(callId)) {
      this.emit("changes.capture.pending", "skipped", "duplicate call id replaced its pending snapshot", sink, detail);
    } else if (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) {
        this.pending.delete(oldest);
        this.emit("changes.capture.pending", "skipped", `pending cap ${MAX_PENDING} reached; evicted oldest call ${oldest}`, sink, detail);
      }
    }
    this.pending.set(callId, pending);
  }

  private emit(operation: string, kind: "failed" | "skipped", cause: string, sink: Sink | undefined, detail: Detail): void {
    (sink ?? this.onDiagnostic)?.({ source: "module:changes", operation, kind, cause, recoverable: true, detail });
  }
}
