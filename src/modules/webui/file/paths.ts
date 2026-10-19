// Общий резолвер путей workspace для веб-роутов чтения (`/api/file`, `/api/files`).
//
// Гард двойной: лексический (очевидно внешний путь отвергаем ДО касания ФС) и
// realpath (симлинк/джанкшен внутри воркспейса не должен дотянуться наружу),
// плюс отказ на защищённые пути (секреты/VCS — см. `matchProtectedPath`).
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { matchProtectedPath } from "../../security/protected-paths";

/** True, когда `target` вне `base` (лексически). */
export function escapes(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Класс отказа резолва пути. */
export type PathErrorCode = "outside_workspace" | "protected_path" | "not_found";

/** Результат резолва: реальный абсолютный путь либо класс отказа. */
export type PathResolution =
  | { ok: true; absReal: string; baseReal: string }
  | { ok: false; code: PathErrorCode };

/**
 * Резолвит `raw` (абсолютный или относительно `base`) в реальный путь, держа
 * его внутри `base`. `not_found` — цель не существует/нечитаема (включая
 * битый симлинк).
 */
export async function resolveWorkspacePath(
  base: string,
  raw: string,
): Promise<PathResolution> {
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  if (escapes(resolve(base), abs)) return { ok: false, code: "outside_workspace" };
  let baseReal: string;
  let absReal: string;
  try {
    // `realpath` идёт по симлинкам/джанкшенам; без него ссылка внутри
    // воркспейса указывала бы на любой файл диска в обход гарда ниже.
    baseReal = await realpath(resolve(base));
    absReal = await realpath(abs);
  } catch {
    return { ok: false, code: "not_found" };
  }
  if (escapes(baseReal, absReal)) return { ok: false, code: "outside_workspace" };
  if (matchProtectedPath(baseReal, absReal)) return { ok: false, code: "protected_path" };
  // `baseReal` нужен вызывающим для сравнения путей: `base` может быть
  // алиасом (8.3-имя Windows, симлинк), а `absReal` уже канонический.
  return { ok: true, absReal, baseReal };
}
