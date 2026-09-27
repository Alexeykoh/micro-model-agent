export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: number;
  code?: string | number;
  message: string;
  source?: string;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

export interface InitializeResult {
  capabilities: Record<string, unknown>;
}

export interface LspServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  autoInstall?: boolean;
  /** Per-server kill switch (default true); AND-ed with the global `lsp.enabled`. */
  enabled?: boolean;
  /** Project-root markers for this language (e.g. ["package.json","tsconfig.json"]). */
  workspaceMarkers?: string[];
}

export interface LspConfig {
  enabled: boolean;
  servers: Record<string, LspServerConfig>;
  timeout: number;
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4;
