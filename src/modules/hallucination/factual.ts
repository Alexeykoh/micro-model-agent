import { t } from "../../i18n/index";
import { existsSync } from "fs";
import { join } from "path";

export interface HallucinationCheckResult {
  status: "pass" | "warn" | "retry" | "block";
  reason?: string;
}

const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "md",
  "yaml",
  "yml",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "html",
  "css",
  "scss",
  "less",
  "vue",
  "svelte",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "txt",
  "env",
  "gitignore",
  "dockerignore",
  "dockerfile",
  "makefile",
  "cmake",
  "toml",
  "xml",
  "sql",
  "graphql",
  "proto",
  "wasm",
]);

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

const COMMON_WORDS = new Set(["node.js", "Node.js"]);

export class FactualCheck {
  private knownPaths: Set<string> = new Set();
  private createdPaths: Set<string> = new Set();
  private baseDir: string = process.cwd();

  setBaseDir(dir: string): void {
    this.baseDir = dir;
  }

  trackReadPath(path: string): void {
    this.knownPaths.add(path);
    const base = path.split(/[/\\]/).pop();
    if (base && base !== path) this.knownPaths.add(base);
  }

  trackCreatedPath(path: string): void {
    this.knownPaths.add(path);
    const base = path.split(/[/\\]/).pop();
    if (base && base !== path) this.knownPaths.add(base);
    this.createdPaths.add(path);
  }

  trackDeletedPath(path: string): void {
    this.knownPaths.add(path);
    const base = path.split(/[/\\]/).pop();
    if (base && base !== path) this.knownPaths.add(base);
    this.createdPaths.delete(path);
  }

  private pathExistsOnDisk(path: string): boolean {
    try {
      if (
        path.startsWith("/") ||
        path.startsWith("~") ||
        /^[A-Za-z]:/.test(path)
      ) {
        return existsSync(path);
      }
      return existsSync(join(this.baseDir, path));
    } catch {
      return false;
    }
  }

  validate(response: string): HallucinationCheckResult {
    const pathRegex = /[\w\-./]+\.\w+/g;
    const mentionedPaths = response.match(pathRegex) || [];

    const unknownPaths = mentionedPaths.filter((p) => {
      if (this.knownPaths.has(p)) return false;
      if (VERSION_PATTERN.test(p)) return false;
      if (p.startsWith("/")) return false;
      if (COMMON_WORDS.has(p)) return false;
      if (this.pathExistsOnDisk(p)) return false;

      const ext = p.split(".").pop()?.toLowerCase() || "";
      if (!FILE_EXTENSIONS.has(ext)) return false;

      const basename = p
        .split("/")
        .pop()
        ?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (basename) {
        const urlPattern = new RegExp(`(https?|file)://[^\\s]*${basename}`);
        if (urlPattern.test(response)) return false;
      }

      return true;
    });

    if (unknownPaths.length > 0) {
      const uniquePaths = [...new Set(unknownPaths)];
      return {
        status: "warn",
        reason: t("hall.unknown_paths", {
          paths: uniquePaths.slice(0, 3).join(", "),
        }),
      };
    }

    return { status: "pass" };
  }
}
