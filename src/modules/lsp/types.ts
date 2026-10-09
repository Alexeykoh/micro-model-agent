// Типы LSP: диагностики, конфиги серверов, severity.
/** LSP-диагностика (диапазон, severity, код, сообщение, источник). */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /**
   * Severity по спеке **опционален**: отсутствующее значение означает `Error`.
   * Прежде поле было обязательным, и диагностики без него молча отбрасывались
   * фильтрами `severity === 1` (clangd сыпет ещё и `severity: 0`).
   */
  severity?: number;
  code?: string | number;
  message: string;
  source?: string;
}

/**
 * Диагностика уровня error. `undefined`/`0`/нечисло трактуются как ошибка —
 * ровно так, как требует LSP-спека.
 */
export function isErrorDiagnostic(diagnostic: LspDiagnostic): boolean {
  return diagnostic.severity === undefined || diagnostic.severity === 0 || diagnostic.severity === 1;
}

/** Диагностика уровня warning (severity === 2). */
export function isWarningDiagnostic(diagnostic: LspDiagnostic): boolean {
  return diagnostic.severity === 2;
}

/** Параметры нотификации publishDiagnostics. */
export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

/** Результат initialize (capabilities сервера). */
export interface InitializeResult {
  capabilities: Record<string, unknown>;
}

/** Конфиг LSP-сервера: команда, args, env, таймаут, автоустановка, флаги. */
export interface LspServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
  autoInstall?: boolean;
  /** Per-server kill switch (дефолт true); И с глобальным `lsp.enabled`. */
  enabled?: boolean;
  /** Маркеры корня проекта для языка (напр. ["package.json","tsconfig.json"]). */
  workspaceMarkers?: string[];
}

/** Конфиг LSP: глобальный флаг, серверы, таймаут, офлайн-режим. */
export interface LspConfig {
  enabled: boolean;
  servers: Record<string, LspServerConfig>;
  timeout: number;
  /**
   * Офлайн-режим: не использовать `npx`, только глобально установленные
   * бинарники. Env `MMA_LSP_OFFLINE` переопределяет это поле (env сильнее).
   */
  offline?: boolean;
  /**
   * Движок для TypeScript/JavaScript: классический `typescript-language-server`
   * или нативный `tsgo` (`@typescript/native-preview`, ~10× быстрее). Дефолт —
   * классический, чтобы поведение не менялось без явного выбора.
   */
  typescriptEngine?: TypeScriptEngine;
}

/** Движок TS/JS-сервера. */
export type TypeScriptEngine = "typescript-language-server" | "tsgo";

/** Severity диагностики: 1 error, 2 warning, 3 info, 4 hint. */
export type DiagnosticSeverity = 1 | 2 | 3 | 4;
