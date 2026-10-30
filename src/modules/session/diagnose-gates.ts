/**
 * Сигнатура `gate_stall`: сколько ход стоял в финальных гейтах (A15).
 * Вынесено из `diagnose.ts` (правило ≤300).
 */
import type { Signature } from "./diagnose";

/** Минимальный вид записи журнала, который нужен сигнатуре. */
type Entry = Record<string, unknown>;

function str(e: Entry, key: string): string | undefined {
  const v = e[key];
  return typeof v === "string" ? v : undefined;
}

function num(e: Entry, key: string): number | undefined {
  const v = e[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * Простой хода в финальных гейтах: `gate_timing` с суммой выше порога.
 *
 * Пользователь видит ответ, а ход ещё висит — без этой сигнатуры «где именно
 * 120 секунд» остаётся догадкой. Разбивка по гейтам идёт в detail.
 */
export function gateStall(entries: Entry[], thresholdMs: number): Signature[] {
  const slow = entries.filter(
    (e) => e.type === "gate_timing" && (num(e, "duration") ?? 0) > thresholdMs,
  );
  if (slow.length === 0) return [];
  const worst = slow.reduce((a, b) =>
    (num(a, "duration") ?? 0) >= (num(b, "duration") ?? 0) ? a : b,
  );
  const gates = worst.gates as Record<string, unknown> | undefined;
  const parts = Object.entries(gates ?? {})
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k} ${String(v)} мс`);
  return [
    {
      kind: "gate_stall",
      count: slow.length,
      first: str(slow[0], "ts") ?? "",
      last: str(slow[slow.length - 1], "ts") ?? "",
      detail:
        `проход гейтов дольше ${thresholdMs} мс ${slow.length} раз; ` +
        `худший — ${String(num(worst, "duration") ?? "?")} мс` +
        (parts.length ? ` (${parts.join(", ")})` : ""),
    },
  ];
}
