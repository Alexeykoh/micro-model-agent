// Статические командные, path- и pattern-таблицы пресетов безопасности.
//
// Вынесено из `security-policies.ts` (правило #1: ≤300 строк/файл): здесь только
// данные, которые не зависят друг от друга и от порядка сборки политик.
import type { AuditEventType } from "../../config/types";
import {
  BASE_BLACKLIST,
  DANGEROUS_COMMANDS,
  PERMISSIVE_BLACKLIST,
  STRICT_EXTRA_BLACKLIST,
} from "./security-lists";

/** Strict: полный чёрный список (base + strict-дополнение + опасные команды). */
export const STRICT_BASH_BLACKLIST = [
  ...BASE_BLACKLIST,
  ...STRICT_EXTRA_BLACKLIST,
  ...DANGEROUS_COMMANDS,
];

export const STRICT_BASH_WHITELIST = [
  "ls",
  "cat",
  "echo",
  "grep",
  "find",
  "pwd",
  "whoami",
  "date",
];

export const STRICT_DANGEROUS_FLAGS = [
  "--force",
  "-rf",
  "--no-preserve-root",
  "--recursive",
  "--all",
  "-x",
  "-e",
  "--delete",
  "--remove",
  "--dangerous",
  "--yes",
  "-y",
  "--no-confirm",
  "-R",
  "--no-clobber",
];

export const STRICT_DANGEROUS_OPERATORS = [
  ">",
  ">>",
  "2>",
  "2>>",
  "|",
  "&&",
  "||",
  ";",
  "&",
  "`",
  "$(",
];

export const STRICT_DENIED_PATHS = [
  ".git/",
  "node_modules/",
  ".env",
  "*.key",
  "*.pem",
  "*.crt",
  "*.p12",
  "*.pfx",
  "*.secret",
  "*.token",
  "package-lock.json",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".ssh/",
  ".config/",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  "/etc/",
  "/usr/",
  "/var/",
  "/bin/",
  "/sbin/",
  "/root/",
  "/home/",
];

export const STRICT_DENIED_DOMAINS = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "*.internal",
  "*.local",
  "192.168.*",
  "10.*",
  "172.16.*",
];

export const STRICT_CONTENT_PATTERNS = [
  /eval\(/,
  /new Function\(/,
  /child_process\.exec\(/,
  /child_process\.spawn\(/,
  /require\('child_process'\)/,
  /require\('http'\)\.createServer/,
  /require\('net'\)\.createServer/,
  /process\.exit\(/,
  /while\(true\)/,
  /for\(;;\)/,
  /rm -rf/,
  /dd if=/,
  /chmod 777/,
  /wget /,
  /curl /,
  /ssh /,
  /scp /,
];

export const STRICT_AUDIT_EVENTS: AuditEventType[] = [
  "security_block",
  "bash_command",
  "file_operation",
  "network_request",
  "authentication",
  "configuration_change",
  "session_start",
  "session_end",
];

/** Balanced: base + опасные команды. */
export const BALANCED_BASH_BLACKLIST = [...BASE_BLACKLIST, ...DANGEROUS_COMMANDS];

export const BALANCED_DANGEROUS_FLAGS = [
  "--force",
  "-rf",
  "--no-preserve-root",
  "--recursive",
  "--all",
  "--delete",
  "--remove",
  "--dangerous",
  "--yes",
  "-y",
  "--no-confirm",
];

export const BALANCED_DANGEROUS_OPERATORS = ["|", "&&", "||", ";", "&", "`"];

export const BALANCED_DENIED_PATHS = [
  ".git/",
  "node_modules/",
  ".env",
  "*.key",
  "*.pem",
  "*.crt",
  "*.p12",
  "*.pfx",
  "*.secret",
  "*.token",
  "package-lock.json",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".ssh/",
];

export const BALANCED_CONTENT_PATTERNS = [
  /eval\(/,
  /new Function\(/,
  /child_process\.exec\(/,
  /child_process\.spawn\(/,
  /require\('child_process'\)/,
  /process\.exit\(/,
  /while\(true\)/,
  /for\(;;\)/,
  /rm -rf/,
  /dd if=/,
  /chmod 777/,
];

export const BALANCED_AUDIT_EVENTS: AuditEventType[] = [
  "security_block",
  "bash_command",
  "file_operation",
  "network_request",
];

/** Permissive: только безусловно опасные команды. */
export const PERMISSIVE_BASH_BLACKLIST = [...PERMISSIVE_BLACKLIST, ...DANGEROUS_COMMANDS];

export const PERMISSIVE_DANGEROUS_FLAGS = ["--force", "-rf", "--no-preserve-root"];

export const PERMISSIVE_DENIED_PATHS = [".env", "*.key", "*.pem", "*.crt", "*.p12", "*.pfx"];

export const PERMISSIVE_CONTENT_PATTERNS = [
  /eval\(/,
  /new Function\(/,
  /while\(true\)/,
  /for\(;;\)/,
  /rm -rf/,
  /dd if=/,
];

export const PERMISSIVE_AUDIT_EVENTS: AuditEventType[] = ["security_block"];
