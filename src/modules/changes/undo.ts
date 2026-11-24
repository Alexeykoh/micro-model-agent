import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "../../config/types";
import { isInsideDir, safeResolvePath } from "../../tools/path-utils";
import { generateDiff } from "../../ui/diff";
import type { ChangesStore } from "./store";
import type {
  ChangeEntry,
  ListOptions,
  UndoItem,
  UndoOptions,
  UndoResult,
} from "./types";
import {
  effective,
  escapeCause,
  joinDiffs,
  message,
  undoMarkers,
  wasEvicted,
} from "./undo-helpers";

export interface UndoDeps {
  store: ChangesStore;
  getConfig: () => AppConfig;
  baseDir: string;
  log?: (detail: Record<string, unknown>) => void;
}

type Group = { target: ChangeEntry; consumed: ChangeEntry[] };

export class ChangeUndo {
  constructor(private readonly deps: UndoDeps) {}

  setBaseDir(dir: string): void {
    this.deps.baseDir = dir;
  }

  list(options: ListOptions): ChangeEntry[] {
    if (options.baseDir) this.setBaseDir(options.baseDir);
    const items = effective(this.deps.store.readEntries(options.sessionId));
    const abs = options.path ? this.resolveTarget(options.path) : null;
    if (options.path && abs === null) return [];
    const filtered =
      abs !== null
        ? items.filter(
            (e) => e.path === options.path || resolve(e.pathAbs) === abs,
          )
        : items;
    const raw = options.limit ?? 10;
    const limit = Number.isSafeInteger(raw) ? Math.max(0, Math.min(raw, 50)) : 10;
    return filtered.reverse().slice(0, limit);
  }

  undo(options: UndoOptions): UndoResult {
    try {
      return this.runUndo(options);
    } catch (err) {
      return { ok: false, message: message(err), items: [] };
    }
  }

  private runUndo(options: UndoOptions): UndoResult {
    if (options.baseDir) this.setBaseDir(options.baseDir);
    const base = resolve(this.deps.baseDir);
    const all = this.deps.store.readEntries(options.sessionId);
    const entries = effective(all);
    if (options.path) {
      const abs = this.resolveTarget(options.path);
      if (abs === null) {
        return { ok: false, message: "path is outside the base directory", items: [] };
      }
      const steps = options.steps ?? 1;
      if (!Number.isSafeInteger(steps) || steps < 1) {
        return { ok: false, message: "invalid steps: expected a positive integer", items: [] };
      }
      const mine = entries.filter((e) => resolve(e.pathAbs) === abs).reverse();
      if (mine.length < steps) {
        const evicted = wasEvicted(all, (e) => resolve(e.pathAbs) === abs);
        return {
          ok: false,
          message: evicted
            ? `snapshot for ${options.path} was evicted; no undoable version remains`
            : "not enough undo steps for this file",
          items: [],
        };
      }
      const group: Group = { target: mine[steps - 1]!, consumed: mine.slice(0, steps) };
      return this.apply(
        [group],
        options.force === true,
        options.sessionId,
        base,
        steps > 1 ? mine[0] : undefined,
      );
    }
    const turn = options.turn ?? (this.deps.store.loadTurn(options.sessionId) || 1);
    const mine = entries.filter((e) => e.turn === turn).reverse();
    if (mine.length === 0) {
      const evicted = wasEvicted(all, (e) => e.turn === turn);
      return {
        ok: false,
        message: evicted
          ? `snapshots for turn ${turn} were evicted`
          : `no changes recorded in turn ${turn}`,
        items: [],
      };
    }
    return this.apply(
      mine.map((target) => ({ target, consumed: [target] })),
      options.force === true,
      options.sessionId,
      base,
    );
  }

  /** Resolve a caller-supplied path, refusing anything outside the base directory. */
  private resolveTarget(raw: string): string | null {
    const base = resolve(this.deps.baseDir);
    const abs = safeResolvePath(base, raw);
    return isInsideDir(abs, base) ? resolve(abs) : null;
  }

  /** Path policy is checked before conflicts and is never bypassed by force. */
  private pathIssue(e: ChangeEntry, base: string): string | null {
    if (!isInsideDir(e.pathAbs, base)) return "path is outside the base directory";
    if (resolve(e.pathAbs) !== resolve(base, e.path)) {
      return "path does not match its absolute path";
    }
    const cause = escapeCause(base, e.pathAbs);
    if (cause) return cause;
    if (e.op === "move" && e.to) {
      const dest = resolve(base, e.to);
      if (!isInsideDir(dest, base)) {
        return "move destination is outside the base directory";
      }
      const destCause = escapeCause(base, dest);
      if (destCause) return `move destination ${destCause}`;
    }
    return null;
  }

  private apply(
    groups: Group[],
    force: boolean,
    sessionId: string,
    base: string,
    verify?: ChangeEntry,
  ): UndoResult {
    const items: UndoItem[] = [];
    const diffs: string[] = [];
    for (const { target: e, consumed } of groups) {
      const issue = this.pathIssue(e, base);
      if (issue) {
        items.push({ path: e.path, ok: false, reason: issue });
        continue;
      }
      let restored = false;
      let marked = false;
      try {
        // With steps>1 skipped revisions are implied: compare against the newest.
        const reason = this.conflict(verify ?? e, base);
        if (reason && !force) {
          items.push({ path: e.path, ok: false, reason });
          continue;
        }
        const current = this.readText(e.pathAbs);
        const currentSha = this.sha(e.pathAbs);
        this.restore(e, sessionId, base);
        restored = true;
        const restoredSha = this.sha(e.pathAbs);
        this.mark(sessionId, consumed, currentSha, restoredSha);
        marked = true;
        this.deps.log?.({ path: e.path, op: e.op, targetId: e.id, tool: e.tool });
        if (current !== null) {
          try {
            const after = this.readText(e.pathAbs);
            if (after !== null) diffs.push(generateDiff(current, after));
          } catch {
            // Diff output is best-effort; the restore is already committed.
          }
        }
        items.push({ path: e.path, ok: true });
      } catch (err) {
        if (restored && !marked) {
          try {
            this.mark(sessionId, consumed, null, this.sha(e.pathAbs));
          } catch {
            // Best effort: the journal must not claim a restored file is still live.
          }
        }
        items.push({ path: e.path, ok: false, reason: message(err) });
      }
    }
    const ok = items.some((i) => i.ok);
    return {
      ok,
      items,
      message: items
        .map((i) => `${i.path}: ${i.ok ? "restored" : `skipped (${i.reason})`}`)
        .join("; "),
      diff: joinDiffs(diffs),
    };
  }

  /** Invalidate every consumed revision, not only the one whose content was restored. */
  private mark(
    sessionId: string,
    consumed: ChangeEntry[],
    before: string | null,
    after: string | null,
  ): void {
    const turn = this.deps.store.loadTurn(sessionId) || 1;
    for (const marker of undoMarkers(turn, consumed, before, after)) {
      this.deps.store.append(sessionId, marker);
    }
  }

  private conflict(e: ChangeEntry, base: string): string | null {
    if (this.sha(e.pathAbs) !== e.after) return "file changed since the snapshot";
    if (e.op === "move" && e.to) {
      const dest = resolve(base, e.to);
      if (this.sha(dest) !== e.before) {
        return "move destination changed since the snapshot";
      }
    }
    return null;
  }

  private restore(e: ChangeEntry, sessionId: string, base: string): void {
    if (e.op === "move" && e.to) {
      const dest = resolve(base, e.to);
      if (!existsSync(dest)) throw new Error(`move destination missing: ${dest}`);
      // Prefetch both blobs: a missing/corrupt snapshot fails before any write.
      const body = this.deps.store.getBlob(sessionId, e.before);
      const prior = e.toBefore ? this.deps.store.getBlob(sessionId, e.toBefore) : null;
      if (e.toBefore && !prior) throw new Error(`Missing prior content for ${e.to}`);
      const sourceBefore = existsSync(e.pathAbs) ? readFileSync(e.pathAbs) : null;
      const destBefore = readFileSync(dest);
      try {
        if (body) this.write(e.pathAbs, body, e.mode);
        else rmSync(e.pathAbs, { force: true });
        if (prior) this.write(dest, prior, e.toMode);
        else rmSync(dest, { force: true });
      } catch (err) {
        this.rollback(e.pathAbs, sourceBefore);
        this.rollback(dest, destBefore);
        throw err;
      }
      return;
    }
    const body = this.deps.store.getBlob(sessionId, e.before);
    if (body) this.write(e.pathAbs, body, e.mode);
    else rmSync(e.pathAbs, { force: true });
  }

  private rollback(path: string, body: Buffer | null): void {
    try {
      if (body) writeFileSync(path, body);
      else rmSync(path, { force: true });
    } catch {
      // Best effort; no further writes are attempted after a failed restore.
    }
  }

  private write(path: string, body: Buffer, mode?: number): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    if (mode !== undefined) chmodSync(path, mode);
  }

  private sha(path: string): string | null {
    if (!existsSync(path)) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private readText(path: string): string | null {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }
}
