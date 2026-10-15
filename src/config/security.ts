// Дефолты безопасности и мерж с пользовательскими настройками.
import type { SecurityConfig, } from "./types";

/**
 * Дефолтный конфиг безопасности MMA.
 * Баланс между защитой и удобством.
 */
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  bash: {
    enabled: true,
    // Всегда блокируемые команды (опасные).
    blacklist: [
      "rm",
      "dd",
      "chmod",
      "wget",
      "curl",
      "scp",
      "ssh",
      "nc",
      "netcat",
      "mknod",
      "mkfifo",
      "ln",
      "chown",
      "chgrp",
      "useradd",
      "usermod",
      "passwd",
      "sudo",
      "su",
      "exec",
      "eval",
      "source",
      "kill",
      "pkill",
      "killall",
      "shutdown",
      "reboot",
      "halt",
      "poweroff",
      "format",
      "fdisk",
      "parted",
      "mkfs",
      "mount",
      "umount",
      "powershell",
      "pwsh",
      "cmd",
      "bash",
      "sh",
      "zsh",
      "dash",
      "python",
      "python3",
      "node",
      // "bun" осознанно НЕ в блэклисте: системный промпт велит модели
      // гонять TypeScript через `bun <file.ts>` — запрет здесь противоречил бы
      // ему и сжёг целую сессию на блокированных `bun run build`.
      // Произвольный код через флаги всё равно ловит INTERPRETER_FLAGS.
      "perl",
      "ruby",
      "del",
      "rd",
      "erase",
      "taskkill",
    ],
    // Непустой whitelist — разрешены только эти команды.
    whitelist: [],
    // Блок опасных флагов вида --force, -rf и т.п.
    blockDangerousFlags: true,
    // Лог всех выполненных команд в аудит-лог.
    logCommands: true,
    // Всегда блокируемые опасные флаги.
    // Замечание: -y/--yes осознанно отсутствуют — это рутинные безвредные
    // флаги подтверждения (npm init -y, apt-get -y), их блок ломал бы скаффолдинг.
    dangerousFlags: [
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
      "--no-confirm",
    ],
    // Всегда блокируемые опасные операторы (цепочки запрещены — один оператор
    // на команду). Одиночный "&" (фон) в списке нет и остаётся разрешённым.
    dangerousOperators: [">", ">>", "2>", "2>>", ";", "&&", "||", "|", "`", "$("],
  },
  paths: {
    enabled: false,
    // Glob-паттерны всегда запрещённых путей.
    denied: [
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
    ],
    // Непустой allowed — разрешены только эти пути.
    allowed: [],
  },
  network: {
    // SSRF-защита (приватные/link-local IP, не-http схемы) — часть сбалансированной
    // дефолтной политики: без флага проверки isUrlAllowed не стреляют, и веб-тулы
    // дотягиваются до внутренних сетей.
    enabled: true,
    // Всегда запрещённые домены.
    deniedDomains: ["localhost", "127.0.0.1", "::1"],
    // Непустой allowedDomains — разрешены только эти домены.
    allowedDomains: [],
    // Таймаут сетевых запросов (мс).
    requestTimeout: 15000,
    // Максимум размера ответа (байты).
    maxResponseSize: 15000,
    // Loopback/приватные адреса в исходящих вызовах каркаса — deny (D5):
    // снимается только явным флагом, иначе callbackUrl из тела /v1/tasks
    // становится blind SSRF.
    allowPrivateOutbound: false,
  },
  // Максимум глубины рекурсии субагентов.
  maxRecursionDepth: 3,
  // Максимум файловых операций за сессию.
  maxFileOperations: 100,
  // Лимиты частоты LLM-запросов.
  rateLimits: {
    maxRequestsPerMinute: 60,
    maxParallelTasks: 5,
  },
  // Настройки сканирования контента.
  contentScan: {
    enabled: false,
    // Паттерны, считающиеся опасными в содержимом файлов.
    dangerousPatterns: [
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
    ],
  },
  // Настройки шифрования файлов сессии.
  sessionEncryption: {
    enabled: false,
    encryptHistory: true,
    encryptSessionLog: true,
  },
  // Настройки аудит-нотификаций.
  auditNotifier: {
    enabled: false,
    minSeverity: "medium",
    eventTypes: ["security_block", "bash_command", "file_operation", "network_request"],
    maxRetries: 3,
    webhookTimeout: 5000,
  },
};

/**
 * Мержит пользовательский конфиг безопасности с дефолтами.
 * Пользовательский конфиг приоритетнее.
 */
export function mergeSecurityConfig(userConfig?: Partial<SecurityConfig>): SecurityConfig {
  return {
    enabled: userConfig?.enabled ?? DEFAULT_SECURITY_CONFIG.enabled,
    bash: {
      ...DEFAULT_SECURITY_CONFIG.bash,
      ...userConfig?.bash,
    },
    paths: {
      ...DEFAULT_SECURITY_CONFIG.paths,
      ...userConfig?.paths,
    },
    network: {
      ...DEFAULT_SECURITY_CONFIG.network,
      ...userConfig?.network,
    },
    maxRecursionDepth: userConfig?.maxRecursionDepth ?? DEFAULT_SECURITY_CONFIG.maxRecursionDepth,
    maxFileOperations: userConfig?.maxFileOperations ?? DEFAULT_SECURITY_CONFIG.maxFileOperations,
    rateLimits: {
      ...DEFAULT_SECURITY_CONFIG.rateLimits,
      ...userConfig?.rateLimits,
    },
    contentScan: {
      ...DEFAULT_SECURITY_CONFIG.contentScan,
      ...userConfig?.contentScan,
    },
    sessionEncryption: {
      ...DEFAULT_SECURITY_CONFIG.sessionEncryption,
      ...userConfig?.sessionEncryption,
    },
    auditNotifier: {
      ...DEFAULT_SECURITY_CONFIG.auditNotifier,
      ...userConfig?.auditNotifier,
    },
  };
}
