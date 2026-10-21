// Контракты процесса LSP-сервера.
//
// Вынесено из `connection.ts`: типы описывают ТРАНСПОРТ процесса, а не
// соединение (правило 6 AGENTS).

/** Поток stdout/stderr процесса сервера в объёме, нужном транспорту. */
export interface ServerStdout {
  on(event: "data", cb: (chunk: Buffer) => void): void;
}

/** Минимум от процесса сервера (удовлетворяется `ChildProcess`). */
export interface ServerProcess {
  stdin: { writable: boolean; write(chunk: string): boolean } | null;
  stdout: ServerStdout | null;
  /** stderr сервера: если его не читать, сервер встанет на заполненном пайпе. */
  stderr?: ServerStdout | null;
  /** pid процесса сервера — нужен, чтобы убить ВСЁ дерево (аудит §8.1). */
  pid?: number;
  kill(signal?: number | string): boolean;
  once(event: "exit", cb: () => void): void;
  on(event: "error", cb: (error: Error) => void): void;
}

/** Как именно нужно стартовать процесс (после резолва npx/офлайна). */
export interface LaunchPlan {
  command: string;
  args: string[];
}

/** Фабрика процесса сервера; по умолчанию — реальный spawn с Windows-путём. */
export type ServerProcessFactory = (plan: LaunchPlan, cwd: string) => Promise<ServerProcess>;

/** Состояние одного синкаемого документа (версия для `didChange`). */
export interface DocumentState {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  open: boolean;
}

/** Запись диагностик документа: версия, на которой они посчитаны. */
export interface DiagnosticRecord {
  version: number;
  diagnostics: import("./types").LspDiagnostic[];
}

/** Тело `textDocument/publishDiagnostics`. */
export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics?: import("./types").LspDiagnostic[];
  version?: number;
}

/** Ответ `textDocument/diagnostic` (pull-модель, LSP 3.17). */
export interface DocumentDiagnosticReport {
  kind?: "full" | "unchanged";
  items?: import("./types").LspDiagnostic[];
  resultId?: string;
}
