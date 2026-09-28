/**
 * Disk-state resolver for artifact-claim checks (Fix B2).
 *
 * Extracts file-like tokens from the final answer, stats them under baseDir
 * and parses machine-checkable formats — pure JSON via `JSON.parse`, the XML
 * family via `checkXmlWellFormed`. Compiler-backed formats (TS/JS) are
 * existence-only: spawning a build inside the acceptance gate would be slow
 * and flaky, and the plan verifier already covers them for planned work.
 *
 * Bounded (max paths, max bytes) and jail-checked: tokens resolving outside
 * baseDir are skipped, never read.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { extractFileLikeTokens } from "../../modules/hallucination/js-identifiers";
import type { ArtifactState } from "../../modules/hallucination/artifact-claim";
import { checkXmlWellFormed } from "../../tools/syntax-validator";

const MAX_PATHS = 10;
const MAX_BYTES = 500 * 1024;

const JSON_EXTS = new Set([".json", ".jsonc"]);
const XML_EXTS = new Set([".xml", ".drawio", ".svg", ".xaml", ".plist", ".iml"]);

function parseIfSupported(ext: string, content: string): string | undefined {
  if (JSON_EXTS.has(ext)) {
    try {
      JSON.parse(content);
      return undefined;
    } catch (e) {
      return `invalid JSON: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
    }
  }
  if (XML_EXTS.has(ext)) {
    return checkXmlWellFormed(content) ?? undefined;
  }
  return undefined;
}

export function resolveArtifactStates(baseDir: string, response: string): ArtifactState[] {
  if (!response) return [];
  const out: ArtifactState[] = [];
  for (const token of extractFileLikeTokens(response).slice(0, MAX_PATHS)) {
    const abs = isAbsolute(token) ? token : resolve(baseDir, token);
    const rel = relative(baseDir, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const state = resolveOneArtifact(token, abs);
    if (state) out.push(state);
  }
  return out;
}

/** Stats (and parses, when supported) a single in-jail path. Null when unreadable. */
function resolveOneArtifact(token: string, abs: string): ArtifactState | null {
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { path: token, exists: false };
    size = st.size;
  } catch {
    return { path: token, exists: false };
  }
  if (size > MAX_BYTES) return { path: token, exists: true };
  let content: string;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    // Unreadable between stat and read — exists, unverified.
    return { path: token, exists: true };
  }
  return { path: token, exists: true, parseError: parseIfSupported(extname(token).toLowerCase(), content) };
}
