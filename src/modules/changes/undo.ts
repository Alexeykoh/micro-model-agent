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

export interface UndoDeps {
  store: ChangesStore;
  getConfig: () => AppConfig;
  baseDir: string;
  log?: (detail: Record<string, unknown>) => void;
}

export class ChangeUndo {
  constructor(private readonly deps: UndoDeps) {}

  setBaseDir(dir: string): void {
    this.deps.baseDir = dir;
  }

  list(options: ListOptions): ChangeEntry[] {
    if (options.baseDir) this.setBaseDir(options.baseDir);
    const items = this.effective(this.deps.store.readEntries(options.sessionId));
    const abs = options.path ? this.resolveTarget(options.path) : null;
    if (options.path && abs === null) return [];
    const filtered =
      abs !== null
        ? items.filter(
            (e) => e.path === options.path || resolve(e.pathAbs) === abs,
          )
        : items;
    return filtered.reverse().slice(0, Math.min(options.limit ?? 10, 50));
  }

  undo(options: UndoOptions): UndoResult {
    if (options.baseDir) this.setBaseDir(options.baseDir);
    const base = resolve(this.deps.baseDir);
    const all = this.deps.store.readEntries(options.sessionId);
    const entries = this.effective(all);
    if (options.path) {
      const abs = this.resolveTarget(options.path);
      if (abs === null) {
        return { ok: false, message: "path is outside the base directory", items: [] };
      }
      const mine = entries.filter((e) => resolve(e.pathAbs) === abs).reverse();
      const steps = options.steps ?? 1;
      if (steps < 1 || mine.length < steps) {
        const evicted = this.wasEvicted(all, (e) => resolve(e.pathAbs) === abs);
        return {
          ok: false,
          message: evicted
            ? `snapshot for ${options.path} was evicted; no undoable version remains`
            : "not enough undo steps for this file",
          items: [],
        };
      }
      return this.apply(
        [mine[steps - 1]!],
        options.force === true,
        options.sessionId,
        base,
        steps > 1 ? mine[0] : undefined,
      );
    }
    const turn = options.turn ?? (this.deps.store.loadTurn(options.sessionId) || 1);
    const mine = entries.filter((e) => e.turn === turn).reverse();
    if (mine.length === 0) {
      const evicted = this.wasEvicted(all, (e) => e.turn === turn);
      return {
        ok: false,
        message: evicted
          ? `snapshots for turn ${turn} were evicted`
          : `no changes recorded in turn ${turn}`,
        items: [],
      };
    }
    return this.apply(mine, options.force === true, options.sessionId, base);
  }

  private effective(all: ChangeEntry[]): ChangeEntry[] {
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

  private wasEvicted(all: ChangeEntry[], match: (e: ChangeEntry) => boolean): boolean {
    const dead = new Set(
      all.filter((e) => e.op === "evicted" && e.targetId).map((e) => e.targetId!),
    );
    return all.some((e) => dead.has(e.id) && match(e));
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
    if (e.op === "move" && e.to && !isInsideDir(resolve(base, e.to), base)) {
      return "move destination is outside the base directory";
    }
    return null;
  }

  private apply(
    targets: ChangeEntry[],
    force: boolean,
    sessionId: string,
    base: string,
    verify?: ChangeEntry,
  ): UndoResult {
    const items: UndoItem[] = [];
    const diffs: string[] = [];
    for (const e of targets) {
      const issue = this.pathIssue(e, base);
      if (issue) {
        items.push({ path: e.path, ok: false, reason: issue });
        continue;
      }
      try {
        // With steps>1 the skipped intermediate revisions are implied; the
        // current file must match the newest snapshot, not the target's own.
        const reason = this.conflict(verify ?? e, base);
        if (reason && !force) {
          items.push({ path: e.path, ok: false, reason });
          continue;
        }
        const current = this.readText(e.pathAbs);
        const currentSha = this.sha(e.pathAbs);
        this.restore(e, sessionId, base);
        items.push({ path: e.path, ok: true });
        const restored = this.readText(e.pathAbs);
        const restoredSha = this.sha(e.pathAbs);
        if (current !== null && restored !== null) {
          diffs.push(generateDiff(current, restored));
        }
        this.deps.store.append(sessionId, {
          v: 1,
          id: `ch_undo_${Date.now()}_${e.id}`,
          ts: new Date().toISOString(),
          turn: this.deps.store.loadTurn(sessionId) || 1,
          tool: e.tool,
          callId: e.callId,
          op: "undo",
          path: e.path,
          pathAbs: e.pathAbs,
          before: currentSha,
          after: restoredSha,
          bytes: e.bytes,
          targetId: e.id,
        });
        this.deps.log?.({ path: e.path, op: e.op, targetId: e.id, tool: e.tool });
      } catch (err) {
        items.push({
          path: e.path,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const ok = items.some((i) => i.ok);
    return {
      ok,
      items,
      message: items
        .map((i) => `${i.path}: ${i.ok ? "restored" : `skipped (${i.reason})`}`)
        .join("; "),
      diff: diffs.join("\n") || undefined,
    };
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
      const body = this.deps.store.getBlob(sessionId, e.before);
      if (body) this.write(e.pathAbs, body, e.mode);
      else rmSync(e.pathAbs, { force: true });
      if (e.toBefore) {
        const prior = this.deps.store.getBlob(sessionId, e.toBefore);
        if (!prior) throw new Error(`Missing prior content for ${e.to}`);
        this.write(dest, prior);
      } else {
        rmSync(dest, { force: true });
      }
      return;
    }
    const body = this.deps.store.getBlob(sessionId, e.before);
    if (body) this.write(e.pathAbs, body, e.mode);
    else rmSync(e.pathAbs, { force: true });
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
