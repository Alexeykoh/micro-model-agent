// Защита секретов конфиг-каталога и исходников агента от чтения тулами.
// Это не sandbox: цель — не отдавать агенту ключи, чужие сессии и /app.
// DEBT(docker-config-isolation): строковый guard обходится симлинком/переменной;
// настоящая граница — отдельный пользователь или sandbox-контейнер.
import { homedir } from "node:os";
import { resolve, relative } from "node:path";
import { isInsideDir } from "../../tools/path-utils";

const KEY_FILES = new Set([".encryption-key", ".session-encryption-key"]);
const PRIVATE_DIRS = new Set(["sessions", "logs", "memory"]);

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
  const base = target.replace(/^["']+|["']+$/g, "");
  const leaf = base.split(/[\\/]/).pop() ?? "";
  if (KEY_FILES.has(leaf)) return "encryption key file";
  if (base.includes("$MMA_CONFIG_DIR") && /(?:^|[\\/])(sessions|logs|memory)(?:[\\/]|$)/.test(base)) {
    return "private config directory";
  }

  const abs = resolve(baseDir, base);
  const cfg = resolve(configDirPath());
  if (isInsideDir(abs, cfg)) {
    const rel = relative(cfg, abs).replace(/\\/g, "/");
    const parts = rel.split("/");
    if (parts[0] && PRIVATE_DIRS.has(parts[0])) return `private config directory "${parts[0]}"`;
  }

  const app = resolve("/app");
  if (app !== resolve(baseDir) && isInsideDir(abs, app)) return "agent source tree";
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
