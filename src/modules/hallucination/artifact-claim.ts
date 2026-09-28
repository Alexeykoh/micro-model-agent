/**
 * Проверки заявлений об артефактах (ses_mul5pepu_9mdq90): qwen3.5-9b записала fizzbuzz.py,
 * не смогла запустить (python в чёрном списке), затем вставила "ожидаемый" вывод
 * программы с неверными значениями как якобы реальный; также записала schema.drawio
 * с битым `<diagram/>` + висячим `</diagram>` и заявила "валидный XML".
 * Проверка success-claim срабатывает только на сигналы ошибок в выводах тулов,
 * поэтому оба случая прошли молча.
 *
 * Две детерминированные проверки (regex + состояние диска от вызывающего, без LLM):
 * - `checkArtifactClaims`: ответ подаёт файл как созданный/валидный, а на диске
 *   его нет или он не парсится.
 * - `checkUnverifiedOutput`: ответ подаёт кодовый блок как реальный вывод
 *   программы, но ни один тул в окне доказательств ничего успешно не исполнял.
 *
 * Чистые функции — состояние диска (`ArtifactState[]`) резолвит вызывающий
 * (цикл агента, владелец baseDir), модуль остаётся тестируемым.
 * Точность смещена в сторону recall, как в success-claim.ts: ложное срабатывание
 * стоит одну ограниченную re-check итерацию, пропуск — статус-кво.
 */

import type { ClaimContradiction, ClaimToolEvidence } from "./success-claim";

/** Состояние артефакта на диске: путь, наличие, ошибка парсера, формулировка заявления. */
export interface ArtifactState {
  /** Путь относительно проекта, как упомянут в ответе. */
  path: string;
  /** Файл существует на диске под baseDir. */
  exists: boolean;
  /** Ошибка парсера машиночитаемого формата (JSON/XML-семейство), если есть. */
  parseError?: string;
  /** Что ответ утверждает о файле (для retry-сообщения), если детектировано. */
  claim?: string;
}

const WORD = "A-Za-zА-Яа-яЁё0-9_";
const wb = (body: string): RegExp =>
  new RegExp(`(?<![${WORD}])(?:${body})(?![${WORD}])`, "i");

/** Язык успеха про файл (любая локаль, на которой говорит агент). */
const ARTIFACT_SUCCESS_RE = wb(
  "создан[а-яё]*|записан[а-яё]*|сохран[её]н[а-яё]*|готов[а-яё]*|валид[а-яё]*|проверен[а-яё]*|существует|valid(?:ated)?|verified|checked|written|saved|created|exists?|ready",
);

/**
 * Каким словом успеха (если есть) ответ описывает упоминание файла.
 * Возвращает найденное слово для точного retry-сообщения.
 */
function claimedAs(response: string, path: string): string | null {
  const idx = response.toLowerCase().indexOf(path.toLowerCase());
  if (idx === -1) return null;
  // Смотрим окно вокруг упоминания — заявление обычно в том же
  // предложении ("Файл schema.drawio создан и валиден").
  const window = response.slice(Math.max(0, idx - 160), idx + path.length + 160);
  const m = window.match(ARTIFACT_SUCCESS_RE);
  return m ? m[0] : null;
}

/**
 * Возвращает противоречие, если ответ подаёт резолвленный артефакт как
 * созданный/валидный, а на диске его нет или он не парсится.
 */
export function checkArtifactClaims(
  response: string,
  artifacts: ArtifactState[],
): (ClaimContradiction & { path: string }) | null {
  if (!response) return null;
  for (const a of artifacts) {
    const claim = a.claim ?? claimedAs(response, a.path);
    if (!claim) continue;
    if (!a.exists) {
      return {
        tool: "disk",
        path: a.path,
        snippet: `${a.path}: file not found on disk, claimed "${claim}"`,
      };
    }
    if (a.parseError) {
      return {
        tool: "disk",
        path: a.path,
        snippet: `${a.path}: ${a.parseError}, claimed "${claim}"`,
      };
    }
  }
  return null;
}

/** Фразы, подающие кодовый блок как РЕАЛЬНЫЙ вывод исполнения (не пример). */
const OUTPUT_AS_RESULT_RE = wb(
  "вывод программы|вывод команды|результат запуска|результат выполнения|program output|command output|execution result|запустил[а-яё]*.*вывод|покажу вывод|actual output",
);

/** Хеджирование, понижающее блок до ожидания/примера — честно, пропускаем. */
const OUTPUT_HEDGE_RE = wb(
  "ожидаем[а-яё]*|expected|пример[а-яё]*|example|для справки|sample|например|предполагаем[а-яё]*|должен быть|should be",
);

const FENCE_RE = /```/;

/** Тулы, чей успех означает "что-то реально исполнилось". */
const EXEC_TOOLS = new Set(["bash", "process_wait", "pipeline_run"]);

/**
 * Возвращает противоречие, если ответ показывает вывод как результат запуска,
 * но ни один exec-тул в окне доказательств успешно не отработал.
 */
export function checkUnverifiedOutput(
  response: string,
  tools: ClaimToolEvidence[],
): ClaimContradiction | null {
  if (!response || !OUTPUT_AS_RESULT_RE.test(response)) return null;
  if (OUTPUT_HEDGE_RE.test(response)) return null;
  if (!FENCE_RE.test(response)) return null;
  const recent = tools.filter((t) => t.text?.trim()).slice(-10);
  const executed = recent.some((t) => t.ok === true && t.name !== undefined && EXEC_TOOLS.has(t.name));
  if (executed) return null;
  const m = response.match(OUTPUT_AS_RESULT_RE);
  return {
    tool: "no-execution",
    snippet: `claimed "${m?.[0] ?? "output"}" with no successful execution tool in evidence`,
  };
}
