// Ожидание публикации диагностик по push-модели LSP.
//
// Вынесено из `connection.ts` (правило 6). Ключевое: tsserver присылает два
// пуша подряд — сначала пустой (синтаксис), затем семантику через ~140 мс.
// Пустой пуш нельзя отдавать как окончательный ответ, иначе панель покажет
// «ошибок нет» на файле с ошибкой.
import type { DiagnosticRecord } from "./connection-types";
import type { LspDiagnostic } from "./types";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Окно после пустого пуша: короче — риск ложного «ошибок нет»; длиннее —
 * задержка каждого чистого файла.
 */
export const SETTLE_EMPTY_MS = 250;

type ReadRecord = () => DiagnosticRecord | undefined;

/** Ждём запись диагностик нужной версии (опционально — отличную от прежней). */
export async function waitForRecord(
  read: ReadRecord,
  version: number,
  timeoutMs: number,
  differentFrom: DiagnosticRecord | null = null,
): Promise<DiagnosticRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = read();
    if (record && record.version === version && record !== differentFrom) return record;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await delay(Math.min(left, 25));
  }
}

/** Короткое окно после пустого пуша: даёт шанс прийти семантическому набору. */
export async function settleEmptyDiagnostics(
  read: ReadRecord,
  version: number,
): Promise<LspDiagnostic[] | null> {
  const record = await waitForRecord(read, version, SETTLE_EMPTY_MS, read() ?? null);
  return record?.diagnostics ?? null;
}
