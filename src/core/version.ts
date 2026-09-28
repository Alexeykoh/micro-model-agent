/** Версия MMA: читается из package.json в рантайме. */
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

/** Устаревший алиас — используй readMmaVersion(). */
export const readVersion = readMmaVersion;
