/**
 * Plain-text `/memory` rendering for `mma web`.
 *
 * The terminal `/memory` lives in `src/cli/onboarding-commands.ts` and emits
 * ANSI-coloured strings. Web output must stay colour-free (the browser applies
 * its own dim styling), so this re-renders the same `MemoryStore` operations as
 * plain lines instead of importing the CLI layer into a module.
 */
import type { MemoryStore } from "../memory/store";

const CATEGORIES = ["conventions", "decisions", "errors", "facts"] as const;

const USAGE = "/memory [get <k> | set <k> <v> | unset <k> | find <q> | forget <category> <n>]";

/** Pure dispatch: returns the lines to emit, never throws on bad input. */
export function memoryLines(store: MemoryStore, args: string[]): string[] {
  const [sub, ...rest] = args;
  if (!sub) return overview(store);
  switch (sub) {
    case "get": {
      const key = rest[0];
      const prefs = store.getPreferences();
      if (!key || !(key in prefs)) return [`↳ no preference "${key ?? ""}"`];
      return [`${key} = ${prefs[key]}`];
    }
    case "set": {
      const [key, ...value] = rest;
      if (!key || value.length === 0) return [USAGE];
      store.setPreference(key, value.join(" "));
      return [`saved ${key}=${value.join(" ")}`];
    }
    case "unset": {
      const key = rest[0];
      if (!key) return [USAGE];
      return store.deletePreference(key) ? [`removed ${key}`] : [`↳ no preference "${key}"`];
    }
    case "find": {
      const query = rest.join(" ");
      if (!query) return [USAGE];
      const hits = store.search(query);
      return hits.length ? hits.map((h) => `${h.file}  ${h.match}`) : ["↳ no matches"];
    }
    case "forget": {
      const [category, nRaw] = rest;
      if (!category || !(CATEGORIES as readonly string[]).includes(category)) return [USAGE];
      const n = parseInt(nRaw ?? "0", 10);
      const ok = n > 0 && store.deleteEntry(category, n);
      return ok ? [`removed ${category} entry ${n}`] : [`↳ no ${category} entry #${nRaw ?? n}`];
    }
    default:
      return [USAGE];
  }
}

function overview(store: MemoryStore): string[] {
  const out: string[] = [];
  const prefs = Object.entries(store.getPreferences());
  out.push(prefs.length === 0 ? "preferences: (empty)" : "preferences:");
  for (const [k, v] of prefs) out.push(`  ${k} = ${v}`);
  for (const cat of CATEGORIES) {
    const lines = store.read(cat).split(/\r?\n/);
    const idxs = lines.map((l, i) => (l.startsWith("- ") ? i : -1)).filter((i) => i >= 0);
    if (idxs.length === 0) continue;
    out.push(`[${cat}]`);
    for (const i of idxs.slice(-3)) out.push(`  [${idxs.indexOf(i) + 1}] ${lines[i]}`);
  }
  return out;
}
