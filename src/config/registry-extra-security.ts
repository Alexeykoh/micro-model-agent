// Дефы `security.*`: лимиты, bash/paths/network списки, content-scan,
// audit-notifier и шифрование сессий. Вынесены из `registry-extra.ts`
// (правило 6); порядок внутри группы — порядок `EXTRA_DEFS`.
import type { AuditEventType } from "./types";
import type { ConfigKeyDef } from "./registry";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { bool, enumOf, int, jsonShape, list, sec, strOpt } from "./registry-extra-factories";

/** Канонический набор типов аудит-событий (валидация реестра и setup-визарда). */
export const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  "security_block",
  "bash_command",
  "file_operation",
  "network_request",
  "tool_call",
  "authentication",
  "configuration_change",
  "session_start",
  "session_end",
];

export const SECURITY_EXTRA_DEFS: ConfigKeyDef[] = [
  int("security.maxRecursionDepth", "security", 0, 20, 1, false,
    (c) => c.security?.maxRecursionDepth ?? DEFAULT_SECURITY_CONFIG.maxRecursionDepth,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.maxRecursionDepth = v as number;
    }),
  int("security.maxFileOperations", "security", 0, 10000, 10, false,
    (c) => c.security?.maxFileOperations ?? DEFAULT_SECURITY_CONFIG.maxFileOperations,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.maxFileOperations = v as number;
    }),
  int("security.rateLimits.maxRequestsPerMinute", "security", 1, 1000, 1, false,
    (c) => c.security?.rateLimits.maxRequestsPerMinute ?? DEFAULT_SECURITY_CONFIG.rateLimits.maxRequestsPerMinute,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.rateLimits.maxRequestsPerMinute = v as number;
    }),
  int("security.rateLimits.maxParallelTasks", "security", 1, 50, 1, false,
    (c) => c.security?.rateLimits.maxParallelTasks ?? DEFAULT_SECURITY_CONFIG.rateLimits.maxParallelTasks,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.rateLimits.maxParallelTasks = v as number;
    }),

  list("tools.defaultTags", "tools",
    (c) => c.tools.defaultTags,
    (c, v) => { c.tools.defaultTags = v as string[]; },
    { kind: "tags", placeholder: "file" }),

  list("security.bash.blacklist", "security",
    (c) => c.security?.bash.blacklist ?? DEFAULT_SECURITY_CONFIG.bash.blacklist,
    (c, v) => { sec(c).bash.blacklist = v as string[]; },
    { kind: "tags", placeholder: "rm" }),
  list("security.bash.whitelist", "security",
    (c) => c.security?.bash.whitelist ?? DEFAULT_SECURITY_CONFIG.bash.whitelist,
    (c, v) => { sec(c).bash.whitelist = v as string[]; },
    { kind: "tags", placeholder: "bun" }),
  list("security.bash.dangerousFlags", "security",
    (c) => c.security?.bash.dangerousFlags ?? DEFAULT_SECURITY_CONFIG.bash.dangerousFlags,
    (c, v) => { sec(c).bash.dangerousFlags = v as string[]; },
    { kind: "tags", placeholder: "--force" }),
  list("security.bash.dangerousOperators", "security",
    (c) => c.security?.bash.dangerousOperators ?? DEFAULT_SECURITY_CONFIG.bash.dangerousOperators,
    (c, v) => { sec(c).bash.dangerousOperators = v as string[]; },
    { kind: "tags", placeholder: "&&" }),
  list("security.paths.denied", "security",
    (c) => c.security?.paths.denied ?? DEFAULT_SECURITY_CONFIG.paths.denied,
    (c, v) => { sec(c).paths.denied = v as string[]; },
    { kind: "tags", placeholder: ".git/" }),
  list("security.paths.allowed", "security",
    (c) => c.security?.paths.allowed ?? DEFAULT_SECURITY_CONFIG.paths.allowed,
    (c, v) => { sec(c).paths.allowed = v as string[]; },
    { kind: "tags", placeholder: "src/**" }),
  list("security.network.deniedDomains", "security",
    (c) => c.security?.network.deniedDomains ?? DEFAULT_SECURITY_CONFIG.network.deniedDomains,
    (c, v) => { sec(c).network.deniedDomains = v as string[]; },
    { kind: "tags", placeholder: "localhost" }),
  list("security.network.allowedDomains", "security",
    (c) => c.security?.network.allowedDomains ?? DEFAULT_SECURITY_CONFIG.network.allowedDomains,
    (c, v) => { sec(c).network.allowedDomains = v as string[]; },
    { kind: "tags", placeholder: "api.example.com" }),

  int("security.network.requestTimeout", "security", 1000, 120000, 1000, false,
    (c) => c.security?.network.requestTimeout ?? DEFAULT_SECURITY_CONFIG.network.requestTimeout,
    (c, v) => { sec(c).network.requestTimeout = v as number; }),
  int("security.network.maxResponseSize", "security", 1024, 1000000, 1024, false,
    (c) => c.security?.network.maxResponseSize ?? DEFAULT_SECURITY_CONFIG.network.maxResponseSize,
    (c, v) => { sec(c).network.maxResponseSize = v as number; }),
  bool("security.network.allowPrivateOutbound", "security", false,
    (c) => c.security?.network.allowPrivateOutbound ?? DEFAULT_SECURITY_CONFIG.network.allowPrivateOutbound,
    (c, v) => { sec(c).network.allowPrivateOutbound = v as boolean; }),
  bool("security.network.allowLoopback", "security", false,
    (c) => c.security?.network.allowLoopback ?? DEFAULT_SECURITY_CONFIG.network.allowLoopback,
    (c, v) => { sec(c).network.allowLoopback = v as boolean; }),
  jsonShape("security.contentScan.dangerousPatterns", "security",
    (c) => (c.security?.contentScan.dangerousPatterns ?? DEFAULT_SECURITY_CONFIG.contentScan.dangerousPatterns)
      .map((r) => r.source),
    (c, v) => { sec(c).contentScan.dangerousPatterns = (v as string[]).map((s) => new RegExp(s)); },
    (v) => Array.isArray(v) && v.every((s) => {
      if (typeof s !== "string") return false;
      try { new RegExp(s); return true; } catch { return false; }
    }),
    { kind: "tags", placeholder: "eval\\(" }),

  bool("security.auditNotifier.enabled", "security", false,
    (c) => c.security?.auditNotifier.enabled ?? DEFAULT_SECURITY_CONFIG.auditNotifier.enabled,
    (c, v) => { sec(c).auditNotifier.enabled = v as boolean; }),
  strOpt("security.auditNotifier.filePath", "security",
    (c) => c.security?.auditNotifier.filePath ?? "",
    (c, v) => {
      const s = String(v).trim();
      sec(c).auditNotifier.filePath = s.length === 0 ? undefined : s;
    }),
  strOpt("security.auditNotifier.webhookUrl", "security",
    (c) => c.security?.auditNotifier.webhookUrl ?? "",
    (c, v) => {
      const s = String(v).trim();
      sec(c).auditNotifier.webhookUrl = s.length === 0 ? undefined : s;
    }),
  int("security.auditNotifier.webhookTimeout", "security", 1000, 60000, 1000, false,
    (c) => c.security?.auditNotifier.webhookTimeout ?? DEFAULT_SECURITY_CONFIG.auditNotifier.webhookTimeout,
    (c, v) => { sec(c).auditNotifier.webhookTimeout = v as number; }),
  enumOf("security.auditNotifier.minSeverity", "security",
    ["low", "medium", "high", "critical"] as const, false,
    (c) => c.security?.auditNotifier.minSeverity ?? DEFAULT_SECURITY_CONFIG.auditNotifier.minSeverity,
    (c, v) => { sec(c).auditNotifier.minSeverity = v as "low" | "medium" | "high" | "critical"; }),
  jsonShape("security.auditNotifier.eventTypes", "security",
    (c) => c.security?.auditNotifier.eventTypes ?? DEFAULT_SECURITY_CONFIG.auditNotifier.eventTypes,
    (c, v) => { sec(c).auditNotifier.eventTypes = v as AuditEventType[]; },
    (v) => Array.isArray(v) && v.every((e) =>
      typeof e === "string" && (AUDIT_EVENT_TYPES as readonly string[]).includes(e)),
    // Пустой массив = все типы событий (см. описание ключа).
    { kind: "checkboxes", options: AUDIT_EVENT_TYPES }),
  int("security.auditNotifier.maxRetries", "security", 0, 10, 1, false,
    (c) => c.security?.auditNotifier.maxRetries ?? DEFAULT_SECURITY_CONFIG.auditNotifier.maxRetries,
    (c, v) => { sec(c).auditNotifier.maxRetries = v as number; }),

  strOpt("security.sessionEncryption.keyPath", "security",
    (c) => c.security?.sessionEncryption.keyPath ?? "",
    (c, v) => {
      const s = String(v).trim();
      sec(c).sessionEncryption.keyPath = s.length === 0 ? undefined : s;
    }),
  bool("security.sessionEncryption.encryptHistory", "security", false,
    (c) => c.security?.sessionEncryption.encryptHistory ?? DEFAULT_SECURITY_CONFIG.sessionEncryption.encryptHistory,
    (c, v) => { sec(c).sessionEncryption.encryptHistory = v as boolean; }),
  bool("security.sessionEncryption.encryptSessionLog", "security", false,
    (c) => c.security?.sessionEncryption.encryptSessionLog ?? DEFAULT_SECURITY_CONFIG.sessionEncryption.encryptSessionLog,
    (c, v) => { sec(c).sessionEncryption.encryptSessionLog = v as boolean; }),
];
