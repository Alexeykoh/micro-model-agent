import { existsSync } from "fs";
import { dirname, join } from "path";
import type { LspConfig, LspServerConfig } from "./types";

/**
 * LSP server defaults.
 *
 * Strategy: prefer `npx` (auto-downloads) over globally installed binaries.
 * Servers using system tools (rust-analyzer, gopls) have `autoInstall: false`
 * and are skipped silently when not found.
 */
export const DEFAULT_LSP_CONFIG: LspConfig = {
  enabled: true,
  timeout: 15000,
  servers: {
    typescript: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "typescript-language-server",
        "--package",
        "typescript@5",
        "typescript-language-server",
        "--stdio",
      ],
      timeout: 30000,
      autoInstall: true,
      workspaceMarkers: ["package.json", "tsconfig.json"],
    },
    javascript: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "typescript-language-server",
        "--package",
        "typescript@5",
        "typescript-language-server",
        "--stdio",
      ],
      timeout: 30000,
      autoInstall: true,
      workspaceMarkers: ["package.json", "tsconfig.json"],
    },
    python: {
      command: "npx",
      args: ["pyright", "--stdio"],
      timeout: 15000,
      autoInstall: true,
      workspaceMarkers: ["pyproject.toml", "setup.py", "requirements.txt"],
    },
    rust: {
      command: "rust-analyzer",
      timeout: 15000,
      autoInstall: false,
      workspaceMarkers: ["Cargo.toml"],
    },
    go: {
      command: "gopls",
      timeout: 15000,
      autoInstall: false,
      workspaceMarkers: ["go.mod"],
    },
    json: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "vscode-langservers-extracted",
        "vscode-json-language-server",
        "--stdio",
      ],
      timeout: 30000,
      autoInstall: true,
      workspaceMarkers: ["package.json"],
    },
    html: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "vscode-langservers-extracted",
        "--package",
        "typescript@5",
        "vscode-html-language-server",
        "--stdio",
      ],
      timeout: 60000,
      autoInstall: true,
      workspaceMarkers: ["package.json"],
    },
    css: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "vscode-langservers-extracted",
        "--package",
        "typescript@5",
        "vscode-css-language-server",
        "--stdio",
      ],
      timeout: 60000,
      autoInstall: true,
      workspaceMarkers: ["package.json"],
    },
    angular: {
      command: "npx",
      args: [
        "--yes",
        "--package",
        "@angular/language-server",
        "--package",
        "typescript@5",
        "ngserver",
        "--stdio",
        "--tsProbeLocations",
        "./node_modules",
        "--ngProbeLocations",
        "./node_modules",
      ],
      timeout: 60000,
      autoInstall: true,
      workspaceMarkers: ["angular.json"],
    },
  },
};

const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  html: "html",
  css: "css",
  scss: "css",
};

/** Language id for a file extension (via LANGUAGE_MAP), or null when unsupported. */
export function getLanguageForFile(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return LANGUAGE_MAP[ext] ?? null;
}

const ANGULAR_MARKER = "angular.json";
const ANGULAR_LOOKUP_DEPTH = 10;

/**
 * True when the file lives inside an Angular workspace (an `angular.json`
 * marker exists in one of its ancestor directories, bounded lookup).
 */
function isAngularProject(filePath: string): boolean {
  let dir = dirname(filePath);
  for (let i = 0; i < ANGULAR_LOOKUP_DEPTH; i++) {
    if (existsSync(join(dir, ANGULAR_MARKER))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * Config key of the LSP server for a file. `.html` routes to the `angular`
 * server inside Angular workspaces (templates with bindings need the Angular
 * language service) and to the generic `html` server everywhere else.
 */
export function getServerKeyForFile(filePath: string, config: LspConfig): string | null {
  const lang = getLanguageForFile(filePath);
  if (!lang) return null;
  if (lang === "html" && config.servers.angular && isAngularProject(filePath)) {
    return "angular";
  }
  return lang;
}

export function getServerForFile(filePath: string, config: LspConfig): LspServerConfig | null {
  const key = getServerKeyForFile(filePath, config);
  if (!key) return null;
  return config.servers[key] ?? null;
}
