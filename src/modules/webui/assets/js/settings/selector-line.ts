// Compact composer selector line: label building, `/` separators and
// tail-preserving model truncation. Chat status glyphs stay textual per
// docs/design/ui/STYLE.md; Lucide icons here are chrome only.
import { icon } from "../dom.js";

const observed = new WeakSet<HTMLElement>();

/** Shorten from the left, keeping the distinctive tail of a model name. */
export function tailLabel(value: string, maxChars: number): string {
  if (maxChars < 2 || value.length <= maxChars) return value;
  // Drop whole leading segments (e.g. the "[provider] " tag) first: cutting
  // mid-token keeps neither a readable prefix nor a useful model name.
  let tail = value;
  const limit = maxChars - 1; // room for the ellipsis
  while (tail.length > limit) {
    const space = tail.indexOf(" ");
    if (space < 0) break;
    tail = tail.slice(space + 1);
  }
  if (tail.length > limit) tail = tail.slice(tail.length - limit);
  return "…" + tail;
}

/** Build a chip-free selector button; full "label: value" stays in title/aria-label. */
export function setCompactLabel(
  btn: HTMLElement | null,
  label: string,
  value: string,
  leading?: SVGElement,
): void {
  if (!btn) return;
  btn.textContent = "";
  btn.title = label + ": " + value;
  btn.setAttribute("aria-label", btn.title);
  btn.dataset.value = value;
  if (leading) btn.appendChild(leading);
  const b = document.createElement("b");
  const span = document.createElement("span");
  span.dir = "ltr";
  span.textContent = value;
  b.appendChild(span);
  btn.appendChild(b);
  btn.appendChild(icon("chevron-down"));
}

/** Lucide chrome icon for a selector (context = ruler, reasoning = brain). */
export function leadingIcon(name: string): SVGElement {
  return icon(name);
}

/** A `/` is shown only when both neighbouring selectors are visible. */
export function syncSelectorSeparators(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".selector-sep").forEach((sep) => {
    const prev = sep.previousElementSibling as HTMLElement | null;
    const next = sep.nextElementSibling as HTMLElement | null;
    sep.hidden = !prev || !next || prev.hidden || next.hidden;
  });
}

/** Fit the model value into the available width without losing its tail. */
export function fitModelLabel(btn: HTMLElement | null): void {
  if (!btn) return;
  const b = btn.querySelector<HTMLElement>("b");
  const span = b?.querySelector<HTMLElement>("span");
  const full = btn.dataset.value || "";
  if (!b || !span || !full) return;
  const chars = Math.max(8, Math.floor((b.clientWidth || 240) / 7));
  const next = tailLabel(full, chars);
  if (span.textContent !== next) span.textContent = next;
}

/** Install the fit on the model button once; re-fit on every render + resize. */
export function installModelFit(root: ParentNode = document): void {
  const btn = root.querySelector<HTMLElement>('[data-sel="model"] button');
  if (!btn) return;
  const fit = () => fitModelLabel(btn);
  fit();
  if (observed.has(btn)) return;
  observed.add(btn);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(fit).observe(btn);
}
