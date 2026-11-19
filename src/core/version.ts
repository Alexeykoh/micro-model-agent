/** Версия MMA: читается из package.json в рантайме. */
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

/**
 * Читает версию MMA из package.json в рантайме (не статическим импортом —
 * бандлеры инлайнят устаревшее значение на этапе сборки, см. правило №12).
 * @returns версия из package.json либо "0.0.0", если файл не найден/бит.
 */
export function readMmaVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "..", "package.json"), join(here, "..", "package.json")];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (raw.version) return raw.version;
      } catch {
        // Битый package.json — пробуем следующий кандидат
      }
    }
  }
  return "0.0.0";
}

/**
 * True, когда код запущен из дерева исходников (`src/`), а не из собранного
 * `dist/`. Нужен UI, чтобы честно пометить локальную dev-сборку.
 */
export function isDevBuild(): boolean {
  try {
    return /[\\/]src[\\/]/.test(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * Приводит произвольную метку к короткому ID вида `a1b2c`: ровно 5 символов,
 * только латиница/цифры. Пустое или «грязное» значение → `00000`.
 */
export function normalizeBuildId(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  return /^[a-z0-9]{5}$/.test(cleaned) ? cleaned : "00000";
}

/**
 * Короткий ID сборки для футера веба: `dev #a1b2c`. Источники по приоритету:
 * сгенерированный при сборке образа `build-id`, git HEAD (локальный запуск из
 * исходников), затем детерминированный хэш версии и пути. Читается с диска в
 * рантайме, не статическим импортом (правило №12).
 */
export function readDevBuildId(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  for (const path of [join(root, "build-id"), join(here, "..", "build-id")]) {
    if (existsSync(path)) return normalizeBuildId(readFileSync(path, "utf8").trim());
  }
  const headPath = join(root, ".git", "HEAD");
  if (existsSync(headPath)) {
    const head = readFileSync(headPath, "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/)?.[1];
    if (ref?.startsWith("refs/")) {
      const refPath = join(root, ".git", ref);
      if (existsSync(refPath)) return normalizeBuildId(readFileSync(refPath, "utf8").trim());
    }
    return normalizeBuildId(head);
  }
  return normalizeBuildId(
    createHash("sha1").update(`${readMmaVersion()}|${here}`).digest("hex"),
  );
}

/** Устаревший алиас — используй readMmaVersion(). */
export const readVersion = readMmaVersion;
