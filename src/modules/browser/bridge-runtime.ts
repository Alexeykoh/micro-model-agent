// Рантайм для моста браузера: Bun (предпочтительно) или Node.
//
// Мост — отдельный процесс (`bridge-server.mjs`). Раньше он всегда стартовался
// через `node`, и в bun-only-установке (где node не установлен) тул падал с
// ENOENT вместо понятного сообщения (аудит §2.4).
import { existsSync } from "fs";
import { delimiter, join } from "path";

/** Доступные рантаймы моста. */
export type BridgeRuntime = "bun" | "node";

/** Зависимости проверки — подменяются в тестах. */
export interface RuntimeDeps {
  /** Работает ли процесс под Bun? */
  isBun: boolean;
  /** Есть ли исполняемый файл по пути? */
  pathExists: (path: string) => boolean;
  /** PATH для поиска node. */
  pathEnv?: string;
}

/** Ищет исполняемый файл в PATH (win32: node.exe, posix: node). */
export function findExecutable(
  name: string,
  pathEnv = process.env.PATH ?? "",
  pathExists: (path: string) => boolean = existsSync,
): boolean {
  const isWin = process.platform === "win32";
  const candidates = isWin ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      if (pathExists(join(dir, candidate))) return true;
    }
  }
  return false;
}

/** Итог выбора рантайма: сам рантайм либо понятная ошибка. */
export type RuntimeChoice = { runtime: BridgeRuntime } | { error: string };

/**
 * Выбирает рантайм для моста: Node, если он есть в PATH, иначе Bun.
 *
 * Порядок именно такой: мост поднимает Chromium через Playwright, и под Bun
 * запуск браузера зависает без ответа (проверено на 2026-10-21: `launch` в
 * bridge-server.mjs под Bun не возвращает ничего). Поэтому Node — основной
 * путь, Bun — запасной для bun-only-установок.
 */
export function resolveRuntime(deps: RuntimeDeps): RuntimeChoice {
  if (deps.pathExists && findExecutable("node", deps.pathEnv, deps.pathExists)) {
    return { runtime: "node" };
  }
  if (deps.isBun) return { runtime: "bun" };
  return {
    error:
      "Browser unavailable: neither bun nor node found on PATH. Install Bun (bunx playwright install chromium) or Node.",
  };
}

/** Рантайм по умолчанию — для рабочего кода. */
export function currentRuntime(): RuntimeChoice {
  return resolveRuntime({ isBun: Boolean(process.versions.bun), pathExists: existsSync });
}
