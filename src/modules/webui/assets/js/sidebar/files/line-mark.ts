// Прокрутка и подсветка строки в просмотрщике Files (переход из панели LSP).
//
// Вынесено из `sidebar/files.ts` (правило 6): сам файл отвечает за навигацию и
// загрузку, а «найти строку в уже отрисованном тексте» — отдельная задача.

const LINE_MARK_MS = 2600;

/**
 * Верх прокрутки, при котором строка `line` оказывается на трети экрана.
 * Чистая функция: прокрутка проверяется тестом без реального layout.
 */
export function lineScrollTop(
  line: number,
  lineHeight: number,
  paddingTop: number,
  viewportHeight: number,
): number {
  const top = paddingTop + Math.max(0, line - 1) * lineHeight;
  return Math.max(0, top - viewportHeight / 3);
}

/** Прокрутить вьюер к строке и подсветить её на пару секунд. */
export function markAndScrollToLine(body: HTMLElement | null, line: number): void {
  const fv = body?.querySelector<HTMLElement>(".fv");
  const code = body?.querySelector<HTMLElement>(".fcode");
  if (!body || !fv || !code) return;
  const cs = getComputedStyle(code);
  const lineHeight = Number.parseFloat(cs.lineHeight) || 17;
  const paddingTop = Number.parseFloat(cs.paddingTop) || 0;
  const top = paddingTop + (line - 1) * lineHeight;
  body.scrollTop = lineScrollTop(line, lineHeight, paddingTop, body.clientHeight);
  fv.querySelector(".fv-line-mark")?.remove();
  const mark = document.createElement("div");
  mark.className = "fv-line-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.style.top = `${top}px`;
  mark.style.height = `${lineHeight}px`;
  fv.appendChild(mark);
  window.setTimeout(() => mark.remove(), LINE_MARK_MS);
}
