import { existsSync } from "fs";
import { resolve } from "path";
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

function looksLikeFilePath(s: string): boolean {
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
      const abs = resolve(this.baseDir, fp);
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
    const pattern = /\b[\w./\\-]+\.[a-z]{2,6}\b/gi;
    const matches = text.match(pattern) || [];
    return [...new Set(matches)].filter(looksLikeFilePath);
  }
}
