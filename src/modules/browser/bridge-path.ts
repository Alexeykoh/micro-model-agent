// Поиск скрипта node-моста: раскладки src/ и dist/ (тестируемо без запуска моста).
import { existsSync } from "fs";

/**
 * Первый существующий путь из кандидатов, иначе — первый кандидат.
 * Вынесено из bridge-client.ts, чтобы резолв раскладки src-vs-dist
 * тестировался без спавна node-моста (пути читаются с диска в рантайме, не инлайнятся).
 */
export function pickExistingPath(candidates: string[], fallback = candidates[0]): string {
  return candidates.find((p) => existsSync(p)) ?? fallback;
}
