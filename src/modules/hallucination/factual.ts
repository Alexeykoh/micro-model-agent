import { existsSync } from "fs";
import { resolve, isAbsolute } from "path";
import type { HallucinationCheckResult } from "./detector";
import { t } from "../../i18n/index";

const NON_FILE_EXTENSIONS = new Set([
  "com",
  "org",
  "net",
  "gov",
  "edu",
  "io",
  "dev",
  "app",
  "co",
  "ai",
  "ru",
  "de",
  "fr",
  "uk",
  "us",
  "es",
  "it",
  "jp",
  "cn",
  "br",
]);

/** Well-known runtime/library names that end in .js/.ts but are NOT files. */
const TECH_NAMES = new Set([
  "node.js",
  "react.js",
  "vue.js",
  "next.js",
  "angular.js",
  "express.js",
  "deno.js",
  "qwik.js",
  "svelte.js",
  "jquery.js",
]);

function looksLikeFilePath(s: string): boolean {
  const lower = s.toLowerCase();
  // "Node.js" etc. are technologies, not files — never flag them.
  if (TECH_NAMES.has(lower)) return false;
  if (!s.includes("/") && !s.includes("\\") && !s.match(/^\w+\.[a-z]{2,4}$/i))
    return false;
  const ext = s.split(".").pop()?.toLowerCase() || "";
  return !NON_FILE_EXTENSIONS.has(ext);
}

export class FactualCheck {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  validate(response: string): HallucinationCheckResult {
    const filePaths = this.extractFilePaths(response);
    if (filePaths.length === 0) return { status: "pass" };

    const nonExistent: string[] = [];
    for (const fp of filePaths) {
      const abs = isAbsolute(fp) ? fp : resolve(this.baseDir, fp);
      if (!existsSync(abs)) {
        nonExistent.push(fp);
      }
    }

    if (nonExistent.length > 0) {
      return {
        status: "warn",
        reason: t("hall.unknown_paths", {
          paths: nonExistent.slice(0, 5).join(", "),
        }),
      };
    }

    return { status: "pass" };
  }

  private extractFilePaths(text: string): string[] {
    // Capture absolute Windows paths (with drive letter) and relative paths.
    // The old pattern started at a word boundary, so "E:\project\src\a.ts"
    // only matched "project\src\a.ts" — resolve() then glued that onto
    // baseDir producing a bogus path and a false "unknown file" warning
    // even for files that actually exist on disk.
    const pattern =
      /\b(?:[a-zA-Z]:[\\/])?[\w./\\-]+\.[a-z]{2,6}\b/gi;
    const matches = text.match(pattern) || [];
    return [...new Set(matches)].filter(looksLikeFilePath);
  }
}
