// Миниатюра картинки тула (browser screenshot / attach_image) в ленте + общий
// фолбэк «картинки больше нет» (ротация/чистка на диске). Leaf-модуль:
// dom + i18n + lightbox — и live `tool_end`, и replay истории используют его.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { openLightbox } from "../lightbox.js";

/** Подпись под миниатюрой: вложение или область просмотра браузера. */
function captionOf(toolName: string): string {
  return toolName === "attach_image"
    ? t("web.card.attached_image")
    : t("web.card.browser_viewport");
}

/** Содержимое карточки при отсутствии файла (bitwise-совместимо с `<img>`). */
function missingContent(card: HTMLElement, caption: string): void {
  card.className = "imgcard-missing";
  card.replaceChildren();
  card.appendChild(document.createTextNode("◧ " + t("web.card.image_removed")));
  card.appendChild(el("div", "cap", caption));
}

/**
 * Карточка-миниатюра: `<img loading=lazy>` + подпись, клик — лайтбокс.
 * `onerror` (файл вытеснен ротацией) — приглушённая пометка вместо битой
 * картинки. Возвращает `null` только при пустом URL.
 */
export function imageCard(toolName: string, url: string): HTMLElement | null {
  if (!url) return null;
  const caption = captionOf(toolName);
  const card = el("div", "imgcard");
  const img = document.createElement("img");
  img.className = "imgthumb";
  img.alt = "";
  img.loading = "lazy";
  img.src = url;
  img.addEventListener("error", () => missingContent(card, caption));
  img.addEventListener("click", () => openLightbox(url, caption));
  card.appendChild(img);
  card.appendChild(el("div", "cap", caption));
  return card;
}
