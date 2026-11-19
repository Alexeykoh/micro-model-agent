// Просмотр файла из чата (`mma web`) — модальное окно поверх приложения.
// Оболочка — общий поддиалог (`subdialog.ts`): затемнение, Escape, клик по
// фону, focus trap и возврат фокуса приходят из него, без второй реализации.
// Содержимое рисует тот же рендер, что и вкладка «Файлы»
// (`sidebar/files/view.ts`), поэтому типы текста/markdown/медиа не дублируются.
//
// В отличие от старой панели, чат не скрывается: после закрытия лента остаётся
// на том же месте. Сессионная таб-модель main-окна не перестраивается.
import { el } from "./dom.js";
import { closeSubDialog, openSubDialog } from "./subdialog.js";
import { fetchFile, paintFile, paintLoading } from "./sidebar/files/view.js";

/** Счётчик загрузок: поздний ответ по закрытому/перетёртому пути не рисуется. */
let loadSeq = 0;
/** Наш узел внутри `#subHost`; `null`, когда просмотр закрыт. */
let view: HTMLElement | null = null;

function isOpen(): boolean {
  const overlay = document.getElementById("subOverlay");
  return !!view && view.isConnected && !!overlay && overlay.classList.contains("open");
}

/** Открыть (или заменить открытый) просмотр файла `path` в поддиалоге. */
export function openFilePreview(path: string): void {
  if (!path) return;
  loadSeq += 1;
  const seq = loadSeq;
  const body = el("div", "file-body");
  const wrap = el("div", "file-view");
  wrap.appendChild(body);
  view = wrap;

  // `onClose` срабатывает и по кнопке, и по фону, и по Escape — обнуляем
  // состояние в одном месте, чтобы поздний ответ не попал в скрытый узел.
  openSubDialog(path, wrap, () => {
    loadSeq += 1;
    if (view === wrap) view = null;
  });
  const titleEl = document.getElementById("subTitle");
  if (titleEl) titleEl.title = path;
  paintLoading(body);
  // Фокус внутри диалога: Tab не уходит в чат.
  setTimeout(() => {
    document.getElementById("closeSub")?.focus();
  }, 0);

  void fetchFile(path).then((file) => {
    if (seq !== loadSeq || view !== wrap || !wrap.isConnected) return;
    paintFile(body, path, file);
  });
}

/** Закрыть просмотр; чат остаётся нетронутым. */
export function closeFilePreview(): void {
  if (isOpen()) closeSubDialog();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isOpen()) closeFilePreview();
});
