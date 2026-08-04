const FILE_PATH_RE = /\b[\w./\\-]+\.[a-z]+\b/gi;
const IGNORED_EXT = new Set([
  "tsx",
  "jsx",
  "json5",
  "mdx",
  "yml",
  "yaml",
  "toml",
  "lock",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "css",
  "scss",
  "less",
  "html",
  "jsx",
]);

/**
 * Extract file paths (with extensions) mentioned in a task statement.
 * Used to check whether a generated plan covers every file the task requires.
 */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of text.matchAll(FILE_PATH_RE)) {
    let p = m[0];
    // Trim trailing punctuation that regex greedily keeps (e.g. "test.ts.")
    p = p.replace(/[.,;:)\]>]+$/g, "");
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    if (!p || IGNORED_EXT.has(ext)) continue;
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