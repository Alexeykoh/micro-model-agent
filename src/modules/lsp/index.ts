// Публичный фасад модуля LSP: модуль, клиент, конфиг, типы.
export { LspModule } from "./module";
export { LspClient, FileOnlyLogger, serverKeyFor, type CheckResult } from "./client";
export { getServerForFile, DEFAULT_LSP_CONFIG } from "./config";
export { diagnoseLspServers, classifyLspError } from "./diagnose";
export { LspConnectionPool } from "./pool";
export { findHeaderEnd, parseContentLength, isAcceptableFrameLength } from "./framing";
export { pathToUri, uriToPath } from "./uri";
export { languageIdForPath, serverKeyForPath } from "./language";
export { isErrorDiagnostic, isWarningDiagnostic } from "./types";
export type {
  LspDiagnosis,
  LspServerDiagnosis,
  LspFailureReason,
  LspDiagnoseDeps,
} from "./diagnose";
export type { LspDiagnostic, LspConfig, LspServerConfig, DiagnosticSeverity } from "./types";
