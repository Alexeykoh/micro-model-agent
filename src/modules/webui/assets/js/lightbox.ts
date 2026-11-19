// Лайтбокс: полноэкранный просмотр картинок тулов (клик по миниатюре в ленте).
// Leaf-модуль (dom + i18n + dialog + md): закрытие по Esc/фону/✕, «открыть в
// новой вкладке», «копировать ссылку». Никакого innerHTML — только createElement.
import { el } from "./dom.js";
import { t } from "./i18n.js";
import { setIndicator, trapTab } from "./dialog.js";
import { copyText } from "../md.js";

let root: HTMLDivElement | null = null;
let imgEl: HTMLImageElement | null = null;
let capEl: HTMLElement | null = null;
let openLink: HTMLAnchorElement | null = null;
let copyBtn: HTMLButtonElement | null = null;
let returnFocus: HTMLElement | null = null;

/** Собирает оверлей один раз (лениво, при первом открытии). */
function build(): HTMLDivElement {
  const box = el("div", "lightbox") as HTMLDivElement;
  box.hidden = true;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");

  const close = el("button", "lb-close", "✕");
  close.type = "button";
  close.title = t("web.lightbox.close");
  close.setAttribute("aria-label", t("web.lightbox.close"));

  const figure = el("figure", "lb-figure");
  imgEl = document.createElement("img");
  imgEl.className = "lb-img";
  imgEl.alt = "";
  figure.appendChild(imgEl);
  capEl = el("figcaption", "lb-cap");
  figure.appendChild(capEl);

  const actions = el("div", "lb-actions");
  openLink = el("a", "lb-open") as HTMLAnchorElement;
  openLink.textContent = t("web.lightbox.open_tab");
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  copyBtn = el("button", "lb-copy", t("web.lightbox.copy"));
  copyBtn.type = "button";
  actions.appendChild(openLink);
  actions.appendChild(copyBtn);

  box.appendChild(close);
  box.appendChild(figure);
  box.appendChild(actions);

  close.addEventListener("click", closeLightbox);
  box.addEventListener("click", (e: MouseEvent) => {
    if (e.target === box) closeLightbox();
  });
  box.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeLightbox();
      return;
    }
    trapTab(box, e);
  });
  copyBtn.addEventListener("click", () => {
    const url = openLink?.href || "";
    copyText(url).then((ok: boolean) => setIndicator(t("web.lightbox.copied"), !ok));
  });

  document.body.appendChild(box);
  return box;
}

/** Открыть картинку на весь экран; `caption` — подпись под ней. */
export function openLightbox(src: string, caption?: string): void {
  if (!src) return;
  if (!root) root = build();
  if (!imgEl || !capEl || !openLink || !copyBtn) return;
  imgEl.src = src;
  capEl.textContent = caption || "";
  capEl.hidden = !caption;
  openLink.href = src;
  copyBtn.textContent = t("web.lightbox.copy");
  returnFocus = document.activeElement as HTMLElement | null;
  root.hidden = false;
  root.classList.add("open");
  const close = root.querySelector(".lb-close") as HTMLElement | null;
  if (close) close.focus();
}

/** Закрыть оверлей (безопасный вызов при закрытом). */
export function closeLightbox(): void {
  if (!root || root.hidden) return;
  root.hidden = true;
  root.classList.remove("open");
  if (imgEl) imgEl.removeAttribute("src");
  if (returnFocus && returnFocus.focus) returnFocus.focus();
  returnFocus = null;
}
