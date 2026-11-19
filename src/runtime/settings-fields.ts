/**
 * Пополевые валидаторы настроек: таблицы апплаеров и общие проверки типов.
 * Вынесено из `settings-api.ts` (правило 6, ≤300 строк).
 */

export type FieldApplier<T> = (target: T, value: unknown) => string | null;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((x) => typeof x === "string")) return null;
  return [...value];
}

export function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

export function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 300000;
}

/** Гоняет пополевые апплаеры в порядке таблицы; первая ошибка побеждает. */
export function applyFields<T>(
  target: T,
  patch: Record<string, unknown>,
  appliers: Record<string, FieldApplier<T>>,
): string | null {
  for (const [key, apply] of Object.entries(appliers)) {
    const value = patch[key];
    if (value === undefined) continue;
    const error = apply(target, value);
    if (error) return error;
  }
  return null;
}

export function setTrimmed(
  value: unknown,
  code: string,
  set: (text: string) => void,
  clear: () => void,
): string | null {
  if (typeof value !== "string") return code;
  if (value.trim()) set(value.trim());
  else clear();
  return null;
}
