// Типы безопасности: bash/пути/сеть, сканирование контента, шифрование и аудит.
import type { RateLimitConfig } from "./types-provider";

export interface BashSecurityConfig {
  enabled: boolean;
  blacklist: string[];
  whitelist: string[];
  blockDangerousFlags: boolean;
  logCommands: boolean;
  dangerousFlags: string[];
  dangerousOperators: string[];
}

export interface PathSecurityConfig {
  enabled: boolean;
  denied: string[];
  allowed: string[];
}

export interface NetworkSecurityConfig {
  enabled: boolean;
  deniedDomains: string[];
  allowedDomains: string[];
  requestTimeout: number;
  maxResponseSize: number;
  /** Loopback/приватные адреса в вызовах каркаса (W13, D5); deny по умолчанию. */
  allowPrivateOutbound?: boolean;
  /** Loopback веб-тулов (localhost/127.0.0.1/::1) для dev-сервера; по умолчанию false. */
  allowLoopback?: boolean;
}

export interface ContentScanConfig {
  enabled: boolean;
  dangerousPatterns: RegExp[];
}

export interface SecurityConfig {
  enabled: boolean;
  bash: BashSecurityConfig;
  paths: PathSecurityConfig;
  network: NetworkSecurityConfig;
  maxRecursionDepth: number;
  maxFileOperations: number;
  rateLimits: RateLimitConfig;
  contentScan: ContentScanConfig;
  sessionEncryption: SessionEncryptionConfig;
  auditNotifier: AuditNotifierConfig;
}

export interface SessionIsolationConfig {
  enabled: boolean;
  isolateTempFiles: boolean;
}

export interface SessionEncryptionConfig {
  enabled: boolean;
  encryptHistory: boolean;
  encryptSessionLog: boolean;
  keyPath?: string;
}

export type AuditEventType =
  | "security_block"
  | "bash_command"
  | "file_operation"
  | "network_request"
  | "tool_call"
  | "authentication"
  | "configuration_change"
  | "session_start"
  | "session_end";

export interface AuditNotifierConfig {
  enabled: boolean;
  filePath?: string;
  webhookUrl?: string;
  webhookTimeout?: number;
  minSeverity?: "low" | "medium" | "high" | "critical";
  eventTypes?: AuditEventType[];
  maxRetries?: number;
}
