// Сворачиваемый блок отзыва черновика (A13): в ленте только пометка «кто»,
// причина и вердикт — под тогглом, как размышления. Вынесено из `feed/core.ts`
// (правило 6): core уже у потолка.
import { el, setIcon } from "../dom.js";
import { t } from "../i18n.js";

/** Единый collapsible-блок: общий `.think-h`-обработчик раскрывает его. */
export interface RetractBlock {
  wrap: HTMLElement;
  head: HTMLButtonElement;
  body: HTMLElement;
}

export function buildRetractBlock(
  source: string | undefined,
  reason: string,
  meta?: { verdict?: string; iteration?: number },
): RetractBlock {
  const who =
    source === "critic"
      ? t("web.feed.retract_source_critic")
      : source === "hallucination"
        ? t("web.feed.retract_source_hallucination")
        : source === "audit"
          ? t("web.feed.retract_source_audit")
          : t("web.feed.retract_source_check");
  const wrap = el("div", "think retract-block");
  const head = el("button", "think-h");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  head.appendChild(el("span", "g", "↺"));
  head.appendChild(el("span", "lab", t("web.feed.retract_head", { who })));
  const tog = el("span", "tog");
  setIcon(tog, "chevron-right", t("web.action.show"));
  head.appendChild(tog);
  const body = el("div", "think-body hidden");
  body.appendChild(el("div", "retract-reason", reason || t("web.feed.retract_no_reason")));
  const bits: string[] = [];
  if (meta?.verdict) bits.push(t("web.feed.retract_verdict", { status: meta.verdict }));
  if (typeof meta?.iteration === "number") {
    bits.push(t("web.feed.retract_iteration", { n: String(meta.iteration) }));
  }
  if (bits.length) body.appendChild(el("div", "retract-meta", bits.join(" · ")));
  wrap.appendChild(head);
  wrap.appendChild(body);
  return { wrap, head, body };
}
