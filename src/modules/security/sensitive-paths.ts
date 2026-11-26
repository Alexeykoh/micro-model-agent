// Защита секретов конфиг-каталога и исходников агента от чтения тулами.
// Это не sandbox: цель — не отдавать агенту ключи, чужие сессии и /app.
// Пути раскрываются через $MMA_CONFIG_DIR и симлинки до проверки, чтобы обход
// не сводился к подмене имени; настоящая граница — отдельный пользователь/контейнер.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isInsideDir } from "../../tools/path-utils";

const KEY_FILES = new Set([".encryption-key", ".session-encryption-key"]);
const PRIVATE_DIRS = new Set(["sessions", "logs", "memory"]);

/** Раскрыть ссылки на каталог конфига до проверки: $MMA_CONFIG_DIR и ${...}. */
function expandConfigVars(value: string): string {
  const cfg = configDirPath();
  return value.replace(/\$\{MMA_CONFIG_DIR\}/g, cfg).replace(/\$MMA_CONFIG_DIR\b/g, cfg);
}

/**
 * Весь путь может не существовать (например, сессия ещё не создана), поэтому
 * резолвим самый длинный существующий префикс и приклеиваем хвост. Так symlink
 * в workspace, ведущий в приватный каталог, разворачивается в настоящий путь.
 */
function realWithTail(target: string): string {
  const abs = resolve(target);
  let current = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Каталог конфига: env рантайма, иначе стандартный ~/.mma. */
export function configDirPath(): string {
  return process.env.MMA_CONFIG_DIR || resolve(homedir(), ".mma");
}

/**
 * Причина запрета чтения пути или `undefined` для обычного/разрешённого пути.
 * Разрешены файлы `<config>/config/**` (provider/core/security/ui), но не ключи,
 * сессии, логи и память; `/app` закрыт, если он не является workspace.
 */
export function sensitivePathReason(target: string, baseDir: string): string | undefined {
  const unquoted = target.replace(/^["']+|["']+$/g, "");
  const base = expandConfigVars(unquoted);
  const leaf = base.split(/[\\/]/).pop() ?? "";
  if (KEY_FILES.has(leaf)) return "encryption key file";

  const abs = resolve(baseDir, base);
  const real = realWithTail(abs);
  const cfg = resolve(configDirPath());
  const cfgReal = realWithTail(cfg);
  for (const candidate of new Set([real, abs])) {
    if (isInsideDir(candidate, cfgReal) || isInsideDir(candidate, cfg)) {
      const root = isInsideDir(candidate, cfgReal) ? cfgReal : cfg;
      const rel = relative(root, candidate).replace(/\\/g, "/");
      const parts = rel.split("/");
      if (parts[0] && PRIVATE_DIRS.has(parts[0])) return `private config directory "${parts[0]}"`;
    }
  }

  const app = realWithTail(resolve("/app"));
  if (app !== resolve(baseDir) && (isInsideDir(real, app) || isInsideDir(abs, app))) {
    return "agent source tree";
  }
  return undefined;
}

/** Первый чувствительный путь в shell-команде (по токенам), иначе undefined. */
export function sensitiveCommandReason(command: string, baseDir: string): string | undefined {
  const tokens = command.split(/[\s"'`;|&<>()]+/).filter((t) => t.includes("/") || t.includes("\\"));
  for (const token of tokens) {
    const reason = sensitivePathReason(token, baseDir);
    if (reason) return reason;
  }
  return undefined;
}
