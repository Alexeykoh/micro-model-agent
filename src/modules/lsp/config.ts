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
      args: ["typescript-language-server", "--stdio"],
      timeout: 20000,
      autoInstall: true,
      workspaceMarkers: ["package.json", "tsconfig.json"],
    },
    javascript: {
      command: "npx",
      args: ["typescript-language-server", "--stdio"],
      timeout: 15000,
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
        "vscode-css-language-server",
        "--stdio",
      ],
      timeout: 60000,
      autoInstall: true,
      workspaceMarkers: ["package.json"],
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

export function getServerForFile(filePath: string, config: LspConfig): LspServerConfig | null {
  const lang = getLanguageForFile(filePath);
  if (!lang) return null;
  return config.servers[lang] ?? null;
}
