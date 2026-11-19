// Shared feed render helpers: localized Markdown options, the collapsible
// reasoning block and the per-message copy button. Extracted from `core.ts` so
// the container module stays under the 300-line rule; `core.ts` re-exports the
// public surface, so existing consumers keep importing from there.
import { el, icon, setIcon } from "../dom.js";
import { t } from "../i18n.js";
import { copyText } from "../../md.js";

export interface MdOpts {
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  animate: boolean;
}

// Options passed to the streaming Markdown renderer: localized code-block copy
// labels. Highlighting is applied by `md.js` once a fence closes. `animate`
// wraps live-streamed text chunks in `span.tk` (CSS `tkIn` fade); history
// render and code blocks skip it.
export function mdOpts(animate?: boolean): MdOpts {
  return {
    copyLabel: t("web.code.copy"),
    copiedLabel: t("web.code.copied"),
    copyFailedLabel: t("web.code.copy_failed"),
    animate: animate === true,
  };
}

export interface ThinkBlock {
  wrap: HTMLElement;
  head: HTMLButtonElement;
  body: HTMLElement;
}

// Build the collapsible reasoning block. The global `.think-h` click handler
// depends on this exact structure: wrap > [head, body], body carries `hidden`.
// `live` marks an in-progress block (pulsing label); history renders static.
// `info` — фактическая ступень текущей итерации (SSE `reasoning.level`, INV-R9).
export function buildThinkBlock(
  withDur: boolean,
  live?: boolean,
  info?: { level?: string; source?: string },
): ThinkBlock {
  const wrap = el("div", "think" + (live === false ? "" : " live"));
  const head = el("button", "think-h");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  head.appendChild(el("span", "g", "✦"));
  head.appendChild(el("span", "lab", t("web.action.thinking")));
  if (info?.level) {
    const lvl = el("span", "lvl");
    lvl.append(icon("bulb", "lvl-ico"), el("span", "lvl-t", info.level));
    if (info.source) lvl.title = info.source;
    head.appendChild(lvl);
  }
  if (withDur) head.appendChild(el("span", "dur", ""));
  const tog = el("span", "tog");
  setIcon(tog, "chevron-right", t("web.action.show"));
  head.appendChild(tog);
  const body = el("div", "think-body hidden");
  wrap.appendChild(head);
  wrap.appendChild(body);
  return { wrap, head, body };
}

// Per-message copy action button (whole response as plain text / as Markdown).
export function copyAction(payload: string, labelKey: string): HTMLButtonElement {
  const btn = el("button", "act-btn", t(labelKey));
  btn.type = "button";
  btn.addEventListener("click", () => {
    copyText(payload).then((ok: boolean) => {
      btn.textContent = ok ? "✓ " + t("web.code.copied") : "⚠ " + t("web.code.copy_failed");
      window.setTimeout(() => {
        btn.textContent = t(labelKey);
      }, 1400);
    });
  });
  return btn;
}
