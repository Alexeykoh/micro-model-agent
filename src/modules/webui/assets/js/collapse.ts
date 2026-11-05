// `[data-collapse]` sections: chevron chrome and open/close toggle. Extracted
// from `app.ts` (file-size rule 6).
import { icon } from "./dom.js";

function setArrow(head: HTMLElement, collapsed: boolean): void {
  const arrow = head.querySelector(".arrow");
  if (!arrow) return;
  arrow.textContent = "";
  arrow.appendChild(icon(collapsed ? "chevron-right" : "chevron-down"));
}

/** Wires every collapsible section present in the document. */
export function initCollapsibleSections(): void {
  document.querySelectorAll<HTMLElement>("[data-collapse]").forEach((head) => {
    setArrow(head, false);
    head.addEventListener("click", () => {
      const body = head.nextElementSibling;
      if (!body) return;
      const collapsed = body.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", collapsed ? "false" : "true");
      setArrow(head, collapsed);
    });
  });
}
