// Предпросмотр файла в основном окне (`mma web`): панель-вкладка поверх фида
// чата, как редактор в IDE. Переиспользует загрузку/отрисовку сайдбарного
// вьюера (`sidebar/files/view.ts` — `fetchFile`/`paintFile`), поэтому типы
// текста/markdown/картинки/PDF/медиа не дублируются.
//
// Панель скрывает фид чата, пока открыта; закрытие возвращает чат. Точка
// входа — ссылка на файл в ленте/дерево (см. app.ts / sidebar): она вызывает
// `openMainPreview`, не перестраивая сессионную таб-модель main-окна.
import { el } from "./dom.js";
import { t } from "./i18n.js";
import { msgs } from "./dom.js";
import { fetchFile, paintFile, paintLoading } from "./sidebar/files/view.js";

const panel = document.getElementById("mainPreview");
const pathEl = document.getElementById("mainPreviewPath");
const bodyEl = document.getElementById("mainPreviewBody");
const closeBtn = document.getElementById("mainPreviewClose");

/** Счётчик загрузок: поздний ответ по закрытому/перетёртому пути не рисуется. */
let loadSeq = 0;

function isOpen(): boolean {
  return !!panel && !panel.hidden;
}

/** Показать панель предпросмотра `path` вместо фида чата. */
export function openMainPreview(path: string): void {
  if (!panel || !pathEl || !bodyEl || !path) return;
  loadSeq += 1;
  const seq = loadSeq;
  panel.hidden = false;
  if (msgs) msgs.hidden = true;
  pathEl.textContent = path;
  pathEl.title = path;
  paintLoading(bodyEl);
  void fetchFile(path).then((file) => {
    // Пользователь уже закрыл панель или открыл другой файл — не трогать DOM.
    if (seq !== loadSeq) return;
    paintFile(bodyEl, path, file);
  });
}

/** Закрыть панель, вернуть фид чата. */
export function closeMainPreview(): void {
  if (!panel) return;
  loadSeq += 1;
  panel.hidden = true;
  if (bodyEl) bodyEl.textContent = "";
  if (msgs) msgs.hidden = false;
}

/** Активна ли панель (чтобы переключение вкладок/ссылки не перетёрли чат). */
export function mainPreviewOpen(): boolean {
  return isOpen();
}

if (closeBtn) {
  closeBtn.addEventListener("click", closeMainPreview);
  if (!closeBtn.textContent) closeBtn.appendChild(el("span", "mp-x", "✕"));
  closeBtn.title = t("web.topbar.close");
  closeBtn.setAttribute("aria-label", t("web.topbar.close"));
}
