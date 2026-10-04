// Персист per-session метрик сайдбара `mma web` (usage последнего хода).
// In-memory `sessionUsage` теряется при reload/restart — маленький файл в
// каталоге сессии переживает и то, и другое.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageSnapshot } from "../state";

const FILE = "web-usage.json";

/** Сохраняет снимок usage в каталог сессии. Ошибки глотаются (best-effort). */
export function saveSessionUsage(sessionDir: string, usage: UsageSnapshot): void {
  try {
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, FILE), JSON.stringify(usage), "utf-8");
  } catch {
    /* нет прав/диска — метрики не персистим, UI продолжает с in-memory */
  }
}

/** Читает снимок usage из каталога сессии; undefined — нет/битый/нет доступа. */
export function loadSessionUsage(sessionDir: string): UsageSnapshot | undefined {
  try {
    const path = join(sessionDir, FILE);
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as UsageSnapshot) : undefined;
  } catch {
    return undefined;
  }
}
