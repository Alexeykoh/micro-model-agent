import { t } from "../../i18n/index";

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
  "log",
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

  validate(response: string): HallucinationCheckResult {
    const pathRegex = /[\w\-./]+\.\w+/g;
    const mentionedPaths = response.match(pathRegex) || [];

    const unknownPaths = mentionedPaths.filter((p) => {
      if (this.knownPaths.has(p)) return false;
      if (VERSION_PATTERN.test(p)) return false;
      if (p.startsWith("/")) return false;
      if (COMMON_WORDS.has(p)) return false;

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
