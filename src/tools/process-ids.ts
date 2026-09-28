/** Общие хелперы process_*-тулов: хинт без id, валидация + lookup. */
import { processRegistry, type ManagedProcess } from "../modules/processes";
import { t } from "../i18n/index";

/**
 * Общий ответ "id не дан" для process_*-тулов: хинт использования плюс
 * известные сейчас id (или пометка пустого реестра). Одна копия, чтобы
 * process-kill/log/wait не расходились.
 */
export function missingProcessIdHint(): string {
  const ids = processRegistry.list().map((p) => p.id);
  const listPart = ids.length
    ? `\n${t("proc.list_header")}: ${ids.join(", ")}`
    : `\n${t("proc.missing_id_list")}`;
  return `${t("proc.missing_id")}${listPart}`;
}

/** Итог lookup процесса: запись или готовый вывод для возврата. */
export type ProcessLookup =
  | { ok: true; id: string; entry: ManagedProcess }
  | { ok: false; output: string };

/**
 * Общая валидация id + lookup в реестре для process_*-тулов. Возвращает запись
 * либо `{ ok: false, output }` для прямого возврата (нет id — хинт,
 * неизвестный id — not-found).
 */
export function lookupProcess(args: Record<string, unknown>): ProcessLookup {
  if (args.id === undefined || String(args.id).trim() === "") {
    return { ok: false, output: missingProcessIdHint() };
  }
  const id = String(args.id);
  const entry = processRegistry.get(id);
  if (!entry) {
    return { ok: false, output: t("proc.not_found", { id }) };
  }
  return { ok: true, id, entry };
}
