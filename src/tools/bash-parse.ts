/**
 * Разбор и нормализация shell-команд для тула bash: эвристики перепутанного
 * tool call, парсинг аргументов, Windows-адаптации и echo-редиректы.
 * Вынесено из `bash.ts` (правило 6, ≤300 строк). Решения безопасности здесь не
 * принимаются — только разбор текста команды.
 */
import { platform } from "os";

/**
 * Детект записи файла через `echo/printf ... > file` — частая привычка модели,
 * ломающаяся в cmd.exe: одиночные кавычки не группируют, `>` относится только
 * к ПОСЛЕДНЕЙ строке многострочной команды, двойные кавычки внутри рвут
 * команду. Возвращает целевой файл или null.
 */
export function extractEchoFileWrite(command: string): string | null {
  if (!/^\s*(?:echo|printf)\b/i.test(command)) return null;
  const m = command.match(/[>»]{1,2}\s*"?([^"'\s&|]+)"?/i);
  if (!m) return null;
  return m[1].replace(/["'']$/g, "");
}

/**
 * В cmd.exe разделитель — `&`, а не `;` (bash). Модель регулярно чейнит через
 * `;` — без трансляции cmd отдаёт `;` первым аргументом команды (напр.
 * `node x.ts;` → ENOENT для "x.ts;"). `;` → `&` только ВНЕ двойных кавычек,
 * чтобы `echo "a;b"` уцелел (одиночные в cmd не спецсимвол).
 */
export function translateSemicolonsForCmd(command: string): string {
  let out = "";
  let inQuotes = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      out += ch;
      continue;
    }
    out += ch === ";" && !inQuotes ? "&" : ch;
  }
  return out;
}

export function adaptCommandForWindows(command: string): string {
  if (platform() !== "win32") return command;

  // Модель иногда дописывает `|| true` (bash-идиома гашения ошибок), которой
  // PowerShell не знает. Замена на `; exit 0` — успешный код при любом исходе.
  if (/\|\|\s*true\b/.test(command)) {
    command = command.replace(/\s*\|\|\s*true\b/g, "; exit 0");
  }

  // Windows mkdir не знает -p/--parents, но промежуточные dirs создаёт по умолчанию.
  const trimmed = command.trim();
  if (/^mkdir\s+(-p|--parents)\b/.test(trimmed)) {
    return trimmed.replace(/^mkdir\s+(-p|--parents)\s*/, "mkdir ");
  }
  if (/^mkdir\s+(-p|--parents)\s*$/.test(trimmed)) {
    return "mkdir";
  }

  // Трансляция простых Unix-команд в эквиваленты cmd.exe. Переписывается только
  // ведущее слово; флаги сквозняком (ls -la → dir -la, cmd терпит). Формы с
  // пайпом не трогаем — сломаются.
  const firstWord = trimmed.split(/\s+/)[0]?.split(/[\\/]/).pop();
  const translated = firstWord ? UNIX_TO_WIN_TRANSLATE[firstWord] : undefined;
  if (
    translated &&
    !trimmed.includes("|") &&
    !trimmed.includes(">") &&
    !trimmed.includes("&&") &&
    !trimmed.includes(";")
  ) {
    return trimmed.replace(firstWord!, translated);
  }

  // Адаптации кодировок не надо — UTF-8/OEM-декод в registry.ts.
  return translateSemicolonsForCmd(command);
}

/** Unix-команды, прозрачно транслируемые в эквиваленты cmd.exe. */
const UNIX_TO_WIN_TRANSLATE: Record<string, string> = {
  ls: "dir",
  pwd: "cd",
  cat: "type",
};

/**
 * Shell-команды, которые НИКОГДА не считать перепутанными tool call. Модель
 * часто пишет файлы через `echo '<код со знаками =>` или читает через `cat` —
 * это команды шелла. Без гарда эвристика редиректа срабатывает на любое
 * `<слово> <текст с =>` и падает с "Unknown tool: echo".
 */
export const NEVER_TOOL_CALLS = new Set([
  "echo",
  "cat",
  "type",
  "printf",
  "touch",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "ls",
  "dir",
  "cd",
  "pwd",
  "grep",
  "find",
  "head",
  "tail",
  "wc",
  "chmod",
  "sed",
  "awk",
]);

/** Определяет перепутанный tool call в команде bash. Возврат: тул и сырые аргументы. */
export function detectToolCallInBash(command: string): {
  tool: string;
  args: string;
} | null {
  const match = command.trim().match(/^([\w-]+)\s+(.+)$/s);
  if (!match) return null;
  const tool = match[1];
  // Настоящие shell-команды (echo, cat, …) — никогда не перепутанные tool call.
  if (NEVER_TOOL_CALLS.has(tool)) return null;
  const rest = match[2].trim();
  // Tool call — только если первое слово похоже на snake_case-имя тула, а
  // остаток содержит хотя бы один '=' или JSON-форму.
  if (!/^[a-z][a-z0-9_]+$/.test(tool)) return null;
  if (!rest.includes("=") && !rest.startsWith("{")) return null;
  return { tool, args: rest };
}

/**
 * Парсит сырую строку аргументов перепутанного tool call в Record. Понимает
 * JSON-объекты ("{"path": "..."}") и пары key=value ("path=C:\...\src").
 * Значения — дословным текстом. Возврат: словарь аргументов.
 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      /* fall through to key=value parsing */
    }
  }
  const args: Record<string, unknown> = {};
  // Токенизация с уважением к кавычкам в значениях.
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      // Окаймляющие кавычки значений — снять.
      args[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return args;
}
