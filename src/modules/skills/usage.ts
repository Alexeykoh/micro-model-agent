// Persistent skill-usage counters stored in `~/.mma/skills-usage.json`.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

/** Usage file name inside the global `.mma` directory. */
export const SKILL_USAGE_FILE = "skills-usage.json";

const USAGE_VERSION = 1;

interface UsageFile {
  version?: number;
  counts?: Record<string, unknown>;
}

/**
 * Per-skill load counters.
 *
 * Kept in the global directory (not per session): the top-10 prompt catalog must
 * survive restarts. Reading is tolerant (missing file / corrupt JSON → empty
 * counters); writing is best-effort — a disk error must not break `load_skill`.
 */
export class SkillUsage {
  private readonly filePath: string;
  private readonly counts = new Map<string, number>();

  constructor(private readonly dir: string) {
    this.filePath = join(dir, SKILL_USAGE_FILE);
    this.load();
  }

  /** Increments a name's counter; empty and non-string names are ignored. */
  recordLoad(name: string): void {
    if (typeof name !== "string") return;
    const key = name.trim();
    if (!key) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.save();
  }

  /** How many times a skill was loaded; unknown names return 0. */
  count(name: string): number {
    return this.counts.get(name) ?? 0;
  }

  /** Names with a non-zero count: count desc, then name. */
  topNames(n: number): string[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    return [...this.counts.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, n)
      .map(([name]) => name);
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return; // No file yet — first run.
    }
    try {
      const parsed = JSON.parse(raw) as UsageFile | null;
      const counts = parsed?.counts;
      if (!counts || typeof counts !== "object") return;
      for (const [name, value] of Object.entries(counts)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
        this.counts.set(name, Math.floor(value));
      }
    } catch {
      // Corrupt file: start empty; the next save replaces it.
    }
  }

  private save(): void {
    const payload: UsageFile = { version: USAGE_VERSION, counts: Object.fromEntries(this.counts) };
    try {
      mkdirSync(this.dir, { recursive: true });
      // Atomic swap: a reader never sees a half-written JSON file.
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf-8");
      renameSync(tmp, this.filePath);
    } catch {
      // Best-effort: usage stats are not critical to loading a skill.
    }
  }
}
