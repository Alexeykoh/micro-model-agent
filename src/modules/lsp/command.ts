// Запуск LSP-серверов на Windows: резолв shim (.cmd/.bat) и строка для cmd.exe.
import { delimiter, join } from "path";
import { existsSync } from "fs";
import { platform } from "os";

const WIN_EXTS = [".cmd", ".bat", ".exe", ".com"];

/**
 * Резолв команды для `child_process.spawn` на Windows.
 * Node-`spawn` не исполняет `.cmd`/`.bat`-шимы напрямую без shell, а голый
 * `npx` падает с `spawn npx ENOENT` — на Windows реальный бинарник это
 * `npx.cmd`. Возвращает первый найденный на PATH шим (`npx.cmd`, `npx.bat`,
 * `npx.exe`, …), а если ничего нет — голую команду (spawn упадёт с понятным
 * ENOENT). Не-Windows и команды с расширением/сепаратором — как есть.
 */
export function resolveSpawnCommand(
  command: string,
  platformName: string = platform(),
  pathEnv: string = process.env.PATH ?? "",
): string {
  if (platformName !== "win32") return command;
  // Уже путь или с расширением — пропустить как есть.
  if (
    command.includes("/") ||
    command.includes("\\") ||
    WIN_EXTS.some((ext) => command.toLowerCase().endsWith(ext))
  ) {
    return command;
  }
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of WIN_EXTS) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return `${command}${ext}`;
    }
  }
  return command;
}

/**
 * Склейка резолвленной команды и args в одну строку для cmd.exe.
 * Под Node на Windows `spawn` `.cmd`/`.bat`-шима БЕЗ shell бросает
 * `spawn EINVAL` (CreateProcess не запускает батники напрямую). Резолв
 * `npx` → `npx.cmd` чинит старый `ENOENT`, но не `EINVAL` — shell'а всё равно
 * нет. Надёжный фикс — гнать всю строку через `cmd.exe /d /s /c`
 * (т.е. `spawn(line, { shell: true })`). Хелпер строит строку, квотируя
 * аргументы с cmd-метасимволами, чтобы имена пакетов и флаги LSP-конфигов
 * (`typescript-language-server --stdio`, `pyright --stdio`) пережили round-trip.
 * Не-Windows сюда не ходят (спавнят команду + args напрямую, без shell).
 */
export function buildWinCommandLine(command: string, args: string[]): string {
  const quote = (part: string): string => {
    if (part === "") return '""';
    if (!/[\s"&|^<>()%!]/.test(part)) return part;
    return `"${part.replace(/"/g, '\\"')}"`;
  };
  return [command, ...args].map(quote).join(" ");
}
