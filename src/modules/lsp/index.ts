// Публичный фасад модуля LSP: модуль, клиент, конфиг, типы.
export { LspModule } from "./module";
export { LspClient, FileOnlyLogger } from "./client";
export { getServerForFile, DEFAULT_LSP_CONFIG } from "./config";
export { diagnoseLspServers, classifyLspError } from "./diagnose";
export type {
  LspDiagnosis,
  LspServerDiagnosis,
  LspFailureReason,
  LspDiagnoseDeps,
} from "./diagnose";
export type { LspDiagnostic, LspConfig, LspServerConfig, DiagnosticSeverity } from "./types";
