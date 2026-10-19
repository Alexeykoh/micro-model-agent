/**
 * Детектор путей: абсолютные пути Windows/UNC/POSIX + value-based (workspace/home).
 * URL и e-mail исключаются заранее (`excludedRanges`), чтобы `https://host/a/b` не
 * трактовался как POSIX-путь (Q9).
 */
import type { PolicyContext } from "../context";
import type { Finding } from "../types";
import { excludedRanges, findAll, normalizePath, overlapsAny, type Range } from "../normalize";

/** Известные POSIX-корни: без них `/api/state` не считаем машинным путём. */
const POSIX_ROOTS =
  /\/(?:home|users|root|var|etc|opt|srv|mnt|media|tmp|usr|bin|lib|proc|sys)\/[\w.@+-]/i;

const WIN_ABS = /[A-Za-z]:[\\/][\w.@+~ -]*/g;
const UNC = /\\\\[\w.-]+\\[\w.$@+-]+/g;

/** Value-based: реальные префиксы машины в тексте (workspace/home/доп. корни). */
function valueBasedFindings(text: string, ctx: PolicyContext, excluded: readonly Range[]): Finding[] {
  const needles = [ctx.baseDir, ctx.home, ...(ctx.workspaceRoots ?? [])]
    .filter((v): v is string => typeof v === "string" && v.length > 2)
    .map((v) => normalizePath(v));
  const findings: Finding[] = [];
  const norm = normalizePath(text);
  const seen = new Set<string>();
  for (const needle of needles) {
    if (seen.has(needle)) continue;
    seen.add(needle);
    const ranges = findAll(norm, needle);
    for (const [start, end] of ranges) {
      if (overlapsAny(start, end, excluded)) continue;
      findings.push({ dataClass: "path", kind: "value", start, end, confidence: 1, redact: true });
    }
  }
  return findings;
}

/** Все находки-пути (индекс — `path`). */
export function detectPaths(text: string, ctx: PolicyContext): Finding[] {
  const excluded = excludedRanges(text);
  const findings: Finding[] = valueBasedFindings(text, ctx, excluded);

  for (const re of [WIN_ABS, UNC]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlapsAny(start, end, excluded)) continue;
      // Trim trailing whitespace/punctuation captured by the greedy class.
      const raw = text.slice(start, end).replace(/[ ,.;:)\]}'"]+$/, "");
      findings.push({
        dataClass: "path",
        kind: m[0].startsWith("\\\\") ? "unc" : "windows-abs",
        start,
        end: start + raw.length,
        confidence: 0.95,
        redact: true,
      });
    }
  }

  POSIX_ROOTS.lastIndex = 0;
  let p: RegExpExecArray | null;
  const posix = new RegExp(POSIX_ROOTS.source, "gi");
  while ((p = posix.exec(text)) !== null) {
    const start = p.index;
    const end = start + p[0].length;
    if (overlapsAny(start, end, excluded)) continue;
    findings.push({
      dataClass: "path",
      kind: "posix-abs",
      start,
      end,
      confidence: 0.9,
      redact: true,
    });
  }

  return findings;
}
