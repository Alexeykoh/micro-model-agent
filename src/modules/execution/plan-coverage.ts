import { stripUrls } from "../hallucination/js-identifiers";

/**
 * Coverage-specific extension allow-list. Only real deliverable file types are
 * counted, so prose like `e.g` / `i.e` (extensions `g`/`e`) is never mistaken
 * for a file, while web/doc deliverables (`.css`, `.html`, `.scss`, `.md`) ARE
 * checked — the old deny-list silently skipped them.
 */
const COVERAGE_EXT = new Set([
  // code
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "kt", "kts", "cs", "php", "swift", "c", "cc", "cpp", "cxx", "h", "hpp",
  "lua", "pl", "sh", "bash", "zsh", "bat", "cmd", "ps1", "sql", "vue",
  "svelte", "dart", "scala", "clj",
  // web / docs / config
  "css", "scss", "less", "html", "htm", "md", "mdx", "json", "json5",
  "toml", "yaml", "yml", "ini", "env", "txt",
]);

const FILE_PATH_RE = /\b[\w./\\-]+\.[a-z]{1,6}\b/gi;

/**
 * Extract file paths (with extensions) mentioned in a task statement.
 * Used to check whether a generated plan covers every file the task requires.
 */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of stripUrls(text).matchAll(FILE_PATH_RE)) {
    const p = m[0].replace(/[.,;:)\]>]+$/g, "");
    if (!p) continue;
    // Require a real file name: a non-empty stem before the extension in the
    // last path segment (so `tsx/.ts` / `.env` segments are not "files").
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    const last = slash >= 0 ? p.slice(slash + 1) : p;
    const dot = last.lastIndexOf(".");
    if (dot <= 0) continue;
    if (!COVERAGE_EXT.has(last.slice(dot + 1).toLowerCase())) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }
  return result;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * Compare the file requirements in the task statement against the plan's step
 * descriptions. A requirement is "covered" when its path (or its basename)
 * appears in at least one step. Returns the missing paths.
 */
export function checkPlanCoverage(
  taskText: string,
  stepDescriptions: string[],
): { missing: string[] } {
  const taskPaths = extractFilePaths(taskText);
  if (taskPaths.length === 0) return { missing: [] };

  const stepText = stepDescriptions.map((s) => s.toLowerCase()).join("\n");
  const missing = taskPaths.filter((p) => {
    const lower = p.toLowerCase();
    const base = basename(lower);
    // A step mentioning either the full relative path or its basename counts.
    return !stepText.includes(lower) && !stepText.includes(base);
  });

  return { missing };
}
