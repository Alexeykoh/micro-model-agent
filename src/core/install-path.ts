// Установка MMA: откуда запущен процесс и куда указывает `mma` в PATH.
//
// Нужно, чтобы отличить новую GitHub-Releases-установку (`~/.mma`) от dev-чекаута
// и от legacy npm-сборки. Чистые функции без спавна процессов: PATH сканируется
// напрямую, поэтому результат детерминирован и тестируется на временных каталогах.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Тип установки, из которой запущен текущий процесс. */
export type InstallKind = "release" | "dev" | "npm" | "other";

/** Где `mma` нашёлся в PATH и указывает ли он мимо текущей установки. */
export interface PathShadowing {
  resolved: string | null;
  /** true — `mma` резолвится вне `<installRoot>/bin`. */
  shadowed: boolean;
}

const DEFAULT_PATH_EXT = ".COM;.EXE;.BAT;.CMD";

/** Нормализация пути для сравнения (Windows не различает регистр). */
function norm(path: string, platform: NodeJS.Platform): string {
  const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/** `path` — это `dir` или лежит внутри него. */
export function isUnder(
  path: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!path || !dir) return false;
  const p = norm(path, platform);
  const d = norm(dir, platform);
  return p === d || p.startsWith(`${d}/`);
}

/** Исполняемый файл по имени: на POSIX проверяем X_OK, на Windows — расширения. */
function candidates(
  dir: string,
  command: string,
  platform: NodeJS.Platform,
  pathExt: string,
): string[] {
  if (platform !== "win32") return [join(dir, command)];
  return pathExt
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => join(dir, `${command}${ext.toLowerCase()}`));
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Первое совпадение команды в PATH. Пути перебираются в порядке PATH — именно
 * так резолвит shell, поэтому «кто первый, тот и выиграл».
 */
export function resolveOnPath(
  command: string,
  envPath: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string = process.env.PATHEXT ?? DEFAULT_PATH_EXT,
): string | null {
  const sep = platform === "win32" ? ";" : ":";
  for (const raw of envPath.split(sep)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    for (const candidate of candidates(dir, command, platform, pathExt)) {
      if (isExecutable(candidate, platform)) return resolve(candidate);
    }
  }
  return null;
}

/**
 * Классификация установки:
 * - `release` — entry под installRoot (новая сборка, `~/.mma/current/app/main.js`);
 * - `dev` — TypeScript-исходник (чекаут, `bun run mma`);
 * - `npm` — entry под npm-prefix или содержит `node_modules`;
 * - `other` — всё остальное.
 */
export function classifyInstall(
  entryPath: string,
  installRoot: string,
  npmPrefix?: string,
  platform: NodeJS.Platform = process.platform,
): InstallKind {
  if (!entryPath) return "other";
  if (isUnder(entryPath, installRoot, platform)) return "release";
  if (/\.(ts|tsx|mts|cts)$/i.test(entryPath.split(/[?#]/)[0])) return "dev";
  if (npmPrefix && isUnder(entryPath, npmPrefix, platform)) return "npm";
  if (norm(entryPath, platform).includes("/node_modules/")) return "npm";
  return "other";
}

/**
 * Проверяет, выигрывает ли текущая установка у других `mma` в PATH.
 * `shadowed` считается только при найденном `mma` вне `<installRoot>/bin`:
 * отсутствие `mma` в PATH — не тень, а «новая установка ещё не на PATH».
 */
export function checkPathShadowing(
  installRoot: string,
  envPath: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string = process.env.PATHEXT ?? DEFAULT_PATH_EXT,
): PathShadowing {
  const resolved = resolveOnPath("mma", envPath, platform, pathExt);
  if (!resolved) return { resolved: null, shadowed: false };
  return { resolved, shadowed: !isUnder(resolved, join(installRoot, "bin"), platform) };
}
