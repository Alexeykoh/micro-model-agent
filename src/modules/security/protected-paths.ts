import { resolve, relative } from "path";
import { toForwardSlash } from "../../tools/path-utils";
import { logSecurityBlock } from "./audit-log";
import { t } from "../../i18n/index";

/**
 * Sensitive paths that require explicit user confirmation before modification
 * (VCS internals + secrets/env). This guard is ALWAYS ON — independent of
 * `security.paths.enabled` — because irreversibly deleting `.git/config` or
 * rewriting `.env`/keys is a data-loss risk. It does NOT hard-block: the tool
 * returns a directive telling the model to ask the user and wait.
 */
const DIR_PATTERNS = [".git", ".hg", ".svn"];

const EXACT_BASENAMES = [
  ".env",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".gitconfig",
];

const ENV_PREFIX = ".env.";

const EXT_PATTERNS = [
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".secret",
  ".token",
];

/**
 * Returns the matching protected pattern for `targetPath` (relative to
 * `baseDir`), or `undefined` when the path is ordinary. Matching is
 * case-insensitive and separator-agnostic (win32-safe).
 */
export function matchProtectedPath(baseDir: string, targetPath: string): string | undefined {
  const rel = toForwardSlash(relative(resolve(baseDir), resolve(targetPath))).toLowerCase();
  if (!rel) return undefined;

  for (const dir of DIR_PATTERNS) {
    if (rel === dir || rel.endsWith(`/${dir}`) || rel.startsWith(`${dir}/`) || rel.includes(`/${dir}/`)) {
      return `${dir}/`;
    }
  }

  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";

  for (const name of EXACT_BASENAMES) {
    if (base === name) return name;
  }
  if (base.startsWith(ENV_PREFIX)) return ".env.*";
  for (const ext of EXT_PATTERNS) {
    if (base.endsWith(ext)) return `*${ext}`;
  }

  return undefined;
}

/**
 * Guard helper for mutating file tools: returns a model-facing refusal that
 * tells the model to ask the user, plus an audit entry; `undefined` when the
 * path is ordinary. Never hard-blocks — the user can still approve.
 */
export function protectedPathBlock(
  ctx: { sessionId?: string; baseDir: string },
  targetPath: string,
  pathLabel: string,
  action: "file_write" | "file_delete" = "file_write",
): { success: false; output: string } | undefined {
  const pattern = matchProtectedPath(ctx.baseDir, targetPath);
  if (!pattern) return undefined;
  logSecurityBlock(ctx.sessionId, action, `Protected path: ${pattern}`, pathLabel);
  return {
    success: false,
    output: `[PROTECTED PATH] ${t("file.protected_path_ask", { path: pathLabel, pattern })}`,
  };
}
