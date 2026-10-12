// Clipboard copy + code-block copy button chrome for the streaming Markdown
// renderer — вынесено из `md.ts` (правило ≤300). Без innerHTML: иконки —
// статичные trusted-литералы, импортируются node-by-node из inert DOMParser.
import type { Dict } from "./js/core/store/types.js";

const COPY_ICON =
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
const CHECK_ICON = '<path d="M20 6 9 17l-5-5"/>';

function svgIcon(inner: string): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "svg-icon");
  // The glyphs below are static, trusted literals (never model output).
  const doc = new DOMParser().parseFromString("<svg>" + inner + "</svg>", "image/svg+xml");
  const src = doc.documentElement;
  for (const child of Array.from(src.childNodes)) {
    svg.appendChild(document.importNode(child, true));
  }
  return svg;
}

function setBtnIcon(btn: HTMLElement, inner: string): void {
  btn.replaceChildren(svgIcon(inner));
}

/** Copy `text` to the clipboard. Resolves to `true` on success. */
export function copyText(text: unknown): Promise<boolean> {
  const value = String(text == null ? "" : text);
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(value).then(
      () => true,
      () => fallbackCopy(value),
    );
  }
  return Promise.resolve(fallbackCopy(value));
}

// Legacy path for non-secure origins (`mma web --host <lan-ip>`) and older
// browsers without the async Clipboard API.
function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Creates a disabled copy button for a code block (enabled once the fence closes). */
export function makeCopyButton(opts: Dict): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cb-copy";
  btn.disabled = true;
  btn.setAttribute("aria-label", opts.copyLabel || "copy");
  btn.title = opts.copyLabel || "copy";
  setBtnIcon(btn, COPY_ICON);
  return btn;
}

function flashButton(btn: HTMLButtonElement, inner: string, label: string | null | undefined, ms: number): void {
  const prevTitle = btn.title;
  setBtnIcon(btn, inner);
  if (label) {
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
  btn.classList.add("done");
  window.setTimeout(() => {
    setBtnIcon(btn, COPY_ICON);
    btn.setAttribute("aria-label", prevTitle);
    btn.title = prevTitle;
    btn.classList.remove("done");
  }, ms);
}

/** Wires a copy button to copy `codeEl`'s text with success/failure flash. */
export function wireCopy(btn: HTMLButtonElement, codeEl: HTMLElement, opts: Dict): void {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    void copyText(codeEl.textContent).then((ok) => {
      if (ok) flashButton(btn, CHECK_ICON, opts.copiedLabel || "copied", 1400);
      else flashButton(btn, COPY_ICON, opts.copyFailedLabel || "copy failed", 1800);
    });
  });
}
