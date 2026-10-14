/**
 * Проверка «заявлено создание файла, но файл не создавался» (ses_muwrzm0j):
 * 27B отдала md-контент в чат и заявила «Файл сохранён в /workspace/bike3/…»,
 * не вызвав ни одного write/edit. Резолв по диску не сработал (путь вне baseDir),
 * поэтому нужен детерминированный fallback постварения-в-ответе.
 *
 * Консервативно (иначе ловит обычный пересказ статьи/доков, где упоминаются
 * файлы). Запускается ТОЛЬКО когда все условия держатся:
 *  1) задача пользователя вообще просила файл (file-intent);
 *  2) в заходе не было успешного write_file/edit_file;
 *  3) заявление о сохранении стоит рядом с путь-подобным токеном;
 *  4) заявление — вне ```-фенсов и blockquote (там цитаты контента);
 *  5) рядом нет контекста статьи/документации (статья/доки/«described in»).
 * Один bounded retry, fail-open.
 */

import type { ClaimContradiction, ClaimToolEvidence } from "./success-claim";

/** Задача просит создать файл/документ (extension или глагол сохранения). */
const FILE_INTENT_RE =
  /(\.(?:md|txt|csv|json|html?|pdf|xlsx?|ya?ml|xml)\b|файл|сохрани|запиши|выгруз|создай (?:файл|документ)|save (?:it|this|to|as)|write (?:it|to))/i;

/** Путь с расширением (не URL — их отсекает отдельная проверка). */
const PATH_RE =
  /(?:[A-Za-z]:\\|\/)?[\w./\\-]+\.(?:md|txt|csv|json|html?|pdf|xlsx?|ya?ml|xml|svg|png|jpe?g|py|js|ts|tsx|jsx|go|rs|sh|bat|ps1)\b/gi;

/** Заявление, что файл сохранён/создан (действие или результат действия). */
const FILE_CLAIM_RE =
  /(сохран[её]н|сохранил|записан|записал|создал|готовый файл|файл готов|\bsaved\b|\bwrote\b|\bwritten\b|created the file|file (?:is )?(?:ready|saved|created))/i;

/** Контекст цитирования/объяснения — здесь упоминание файла не заявление агента. */
const DOC_CONTEXT_RE =
  /(статье|статья|документаци|описан|manual|documentation|the article|described in|according to|readme)/i;

/** Убирает ```-фенсы и blockquote-строки: там контент/цитаты, а не заявления. */
function stripQuotedContent(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Запускать ли проверку для этой задачи (file-intent). */
export function taskExpectsFile(taskText: string): boolean {
  return FILE_INTENT_RE.test(taskText);
}

/**
 * Возвращает противоречие, если ответ заявляет о сохранении файла, а за ход не
 * было ни одного write/edit. Null при любом несоответствии guard-ам.
 */
export function checkClaimedFileCreation(
  response: string,
  tools: ClaimToolEvidence[],
  taskText: string,
): ClaimContradiction | null {
  if (!response || !taskExpectsFile(taskText)) return null;
  const prose = stripQuotedContent(response);
  const match = prose.match(PATH_RE);
  if (!match) return null;
  for (let i = 0; i < match.length; i++) {
    const path = match[i];
    const idx = prose.indexOf(path);
    if (idx === -1) continue;
    // URL-токены и чужие протоколы — не заявление о локальном файле.
    const before = prose.slice(Math.max(0, idx - 8), idx);
    if (/:\/\/|https?$/i.test(before)) continue;
    const window = prose.slice(Math.max(0, idx - 140), Math.min(prose.length, idx + path.length + 140));
    if (DOC_CONTEXT_RE.test(window)) continue;
    if (!FILE_CLAIM_RE.test(window)) continue;
    const wrote = tools.some(
      (t) =>
        t.ok !== false &&
        (t.name === "write_file" || t.name === "edit_file" || t.name === "append_file"),
    );
    if (wrote) return null;
    return {
      tool: "file-creation",
      snippet: `claimed saved "${path}" but no write/edit tool ran this turn`,
    };
  }
  return null;
}
