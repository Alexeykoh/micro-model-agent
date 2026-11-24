import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isInsideDir } from "../../tools/path-utils";
import type { ChangeEntry } from "./types";

const MAX_DIFF_LINES = 300;

export const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Live, undoable revisions: no marker targets them and they were snapshotted. */
export function effective(all: ChangeEntry[]): ChangeEntry[] {
  const dead = new Set(
    all
      .filter((e) => (e.op === "undo" || e.op === "evicted") && e.targetId)
      .map((e) => e.targetId!),
  );
  return all.filter(
    (e) =>
      (e.op === "write" || e.op === "delete" || e.op === "move") &&
      !dead.has(e.id) &&
      !e.skipped,
  );
}

export function wasEvicted(
  all: ChangeEntry[],
  match: (e: ChangeEntry) => boolean,
): boolean {
  const dead = new Set(
    all.filter((e) => e.op === "evicted" && e.targetId).map((e) => e.targetId!),
  );
  return all.some((e) => dead.has(e.id) && match(e));
}

/** Mirror of capture's guard: reject symlinks and realpath escapes before writing. */
export function escapeCause(base: string, target: string): string | null {
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return "path is a symbolic link";
  }
  let realBase: string;
  try {
    realBase = realpathSync(base);
  } catch {
    return "base directory is unavailable";
  }
  let probe = resolve(target);
  for (;;) {
    try {
      const real = realpathSync(probe);
      return real === realBase || isInsideDir(real, realBase)
        ? null
        : "path resolves outside the base directory";
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return "path resolves outside the base directory";
      probe = parent;
    }
  }
}

/** Bounded diff output: at most MAX_DIFF_LINES lines plus a truncation notice. */
export function joinDiffs(diffs: string[]): string | undefined {
  const lines: string[] = [];
  for (const diff of diffs) {
    for (const line of diff.split(/\r?\n/)) {
      if (lines.length >= MAX_DIFF_LINES) {
        return `${lines.join("\n")}\n… diff truncated`;
      }
      lines.push(line);
    }
  }
  return lines.join("\n") || undefined;
}

/** One marker per consumed revision, so steps=N invalidates the whole chain. */
export function undoMarkers(
  turn: number,
  consumed: ChangeEntry[],
  before: string | null,
  after: string | null,
): ChangeEntry[] {
  const ts = new Date().toISOString();
  const stamp = Date.now();
  return consumed.map((e) => ({
    v: 1,
    id: `ch_undo_${stamp}_${e.id}`,
    ts,
    turn,
    tool: e.tool,
    callId: e.callId,
    op: "undo",
    path: e.path,
    pathAbs: e.pathAbs,
    before,
    after,
    bytes: e.bytes,
    targetId: e.id,
  }));
}
