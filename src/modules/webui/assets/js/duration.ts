/**
 * Единое форматирование длительностей в веб-UI.
 *
 * Раньше каждая поверхность сама делила миллисекунды на 1000 и выводила
 * «125.4s» — время хода в несколько минут выглядело как непонятное число
 * секунд. Лента, рельс, трейс, LSP, сабагенты и блок критика используют этот
 * модуль: формат меняется в одном месте.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * `500ms` → `1.5s` → `1m 05s` → `1h 01m 05s`.
 * Порог перехода на минуты — ровно 60 с. Отрицательные/нечисловые значения
 * дают пустую строку (как и прежний `formatMs`).
 */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const value = Math.max(0, ms);
  if (value < SECOND) return `${Math.round(value)}ms`;
  if (value < MINUTE) return `${(value / SECOND).toFixed(1)}s`;

  const totalSeconds = Math.floor(value / SECOND);
  const seconds = totalSeconds % 60;
  if (totalSeconds < 3600) {
    return `${Math.floor(totalSeconds / 60)}m ${pad(seconds)}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/** Алиас для вызовов, где длительность уже в секундах. */
export function formatSeconds(seconds: number | null | undefined): string {
  return formatDuration(typeof seconds === "number" ? seconds * SECOND : seconds);
}

/** Пустая длительность не должна занимать место в строке статуса. */
export function hasDuration(ms: number | null | undefined): boolean {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0;
}

/** Экспорт констант для тестов и будущих поверхностей. */
export const DURATION_THRESHOLDS = { SECOND, MINUTE, HOUR } as const;
