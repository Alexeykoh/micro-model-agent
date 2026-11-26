import { existsSync, rmSync, statSync } from "node:fs";
import { DEFAULTS } from "../../config/defaults";
import type { AppConfig } from "../../config/types";
import { isMissingFile } from "./journal";
import type { ChangeEntry } from "./types";

const REVISIONS: ReadonlySet<ChangeEntry["op"]> = new Set([
  "write",
  "delete",
  "move",
]);
const SHA_FIELDS = ["before", "after", "toBefore"] as const;

function shas(e: ChangeEntry): string[] {
  return [
    ...new Set(
      SHA_FIELDS.map((field) => e[field]).filter(
        (sha): sha is string => sha !== null && sha !== undefined,
      ),
    ),
  ];
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

export interface EvictionDeps {
  sessionId: string;
  entries: ChangeEntry[];
  config: AppConfig;
  blobPath: (sha: string) => string;
  append: (entry: ChangeEntry) => void;
}

/**
 * Marker creation and blob deletion are resumable: every `evicted` marker in
 * the journal (including ones from a run that failed mid-deletion) contributes
 * candidate blobs, while live entries always protect the blobs they reference.
 */
export function evictSession(deps: EvictionDeps): void {
  const { sessionId, entries, config, blobPath, append } = deps;
  const cfg = config.changes ?? {};
  const maxBytes = positive(cfg.maxTotalBytes, DEFAULTS.changes!.maxTotalBytes!);
  const maxRevisions = positive(
    cfg.maxRevisionsPerFile,
    DEFAULTS.changes!.maxRevisionsPerFile!,
  );
  const byId = new Map(entries.map((e) => [e.id, e]));
  const dead = new Set(
    entries
      .filter((e) => (e.op === "undo" || e.op === "evicted") && e.targetId)
      .map((e) => e.targetId!),
  );
  const live = entries.filter(
    (e) => REVISIONS.has(e.op) && !dead.has(e.id) && !e.skipped,
  );
  const refs = new Map<string, number>();
  for (const e of live) {
    for (const sha of shas(e)) refs.set(sha, (refs.get(sha) ?? 0) + 1);
  }
  const size = (sha: string): number => {
    const file = blobPath(sha);
    return existsSync(file) ? statSync(file).size : 0;
  };
  let total = [...refs.keys()].reduce((sum, sha) => sum + size(sha), 0);
  const release = (e: ChangeEntry): void => {
    for (const sha of shas(e)) {
      const count = refs.get(sha) ?? 0;
      if (count <= 1) {
        refs.delete(sha);
        total -= size(sha);
      } else {
        refs.set(sha, count - 1);
      }
    }
  };
  const victims: ChangeEntry[] = [];
  const marked = new Set<string>();
  const victimize = (e: ChangeEntry): void => {
    if (marked.has(e.id)) return;
    marked.add(e.id);
    victims.push(e);
    release(e);
  };
  const byPath = new Map<string, ChangeEntry[]>();
  for (const e of live) {
    byPath.set(e.pathAbs, [...(byPath.get(e.pathAbs) ?? []), e]);
  }
  for (const list of byPath.values()) {
    for (const e of list.slice(0, Math.max(0, list.length - maxRevisions))) {
      victimize(e);
    }
  }
  for (const e of live) {
    if (total > maxBytes) victimize(e);
  }
  const ts = new Date().toISOString();
  for (const e of victims) {
    append({
      v: 1,
      id: `ch_ev_${Date.now()}_${e.id}`,
      ts,
      turn: e.turn,
      tool: e.tool,
      callId: e.callId,
      op: "evicted",
      path: e.path,
      pathAbs: e.pathAbs,
      before: e.before,
      after: e.after,
      bytes: e.bytes,
      targetId: e.id,
      skipped: "evicted",
    });
  }
  // Include markers from earlier runs so a failed deletion is retried, and
  // never delete a blob still referenced by any live entry.
  const deletable = new Set<string>();
  for (const marker of entries.filter((e) => e.op === "evicted" && e.targetId)) {
    const target = byId.get(marker.targetId!);
    if (!target) continue;
    for (const sha of shas(target)) if (!refs.has(sha)) deletable.add(sha);
  }
  for (const e of victims) {
    for (const sha of shas(e)) if (!refs.has(sha)) deletable.add(sha);
  }
  const failures: unknown[] = [];
  for (const sha of deletable) {
    const file = blobPath(sha);
    if (!existsSync(file)) continue;
    try {
      rmSync(file);
    } catch (error) {
      if (!isMissingFile(error)) failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Failed to delete ${failures.length} evicted blob(s) for session ${sessionId}`,
      { cause: failures },
    );
  }
}
