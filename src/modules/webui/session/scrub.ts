// Скраб аргументов тула для веб-поверхности (общий для основного форвардера
// и стора прогонов субагентов). Вынесено из `forward.ts`, чтобы стор прогонов
// не импортировал state через forward (иначе цикл импортов WebUiState).
import { redactContextSecrets } from "../../../core/api";

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return redactContextSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = scrubValue(val);
    return out;
  }
  return value;
}

/** Вычищает секреты из аргументов тула, сохраняя форму объекта. */
export function scrubToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubValue(args);
  return scrubbed !== null && typeof scrubbed === "object"
    ? (scrubbed as Record<string, unknown>)
    : {};
}
