import type { LspConfig, LspServerConfig } from './types'

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
      command: 'npx',
      args: ['typescript-language-server', '--stdio'],
      timeout: 20000,
      autoInstall: true,
      workspaceMarkers: ['package.json', 'tsconfig.json'],
    },
    javascript: {
      command: 'npx',
      args: ['typescript-language-server', '--stdio'],
      timeout: 15000,
      autoInstall: true,
      workspaceMarkers: ['package.json', 'tsconfig.json'],
    },
    python: {
      command: 'npx',
      args: ['pyright', '--stdio'],
      timeout: 15000,
      autoInstall: true,
      workspaceMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    },
    rust: {
      command: 'rust-analyzer',
      timeout: 15000,
      autoInstall: false,
      workspaceMarkers: ['Cargo.toml'],
    },
    go: {
      command: 'gopls',
      timeout: 15000,
      autoInstall: false,
      workspaceMarkers: ['go.mod'],
    },
    json: {
      command: 'npx',
      args: ['vscode-json-languageserver', '--stdio'],
      timeout: 10000,
      autoInstall: true,
      workspaceMarkers: ['package.json'],
    },
    html: {
      command: 'npx',
      args: ['vscode-html-languageserver', '--stdio'],
      timeout: 10000,
      autoInstall: true,
      workspaceMarkers: ['package.json'],
    },
    css: {
      command: 'npx',
      args: ['vscode-css-languageserver', '--stdio'],
      timeout: 20000,
      autoInstall: true,
      workspaceMarkers: ['package.json'],
    },
  },
}

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'css',
}

export function getServerForFile(filePath: string, config: LspConfig): LspServerConfig | null {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext) return null
  const lang = LANGUAGE_MAP[ext]
  if (!lang) return null
  return config.servers[lang] ?? null
}
