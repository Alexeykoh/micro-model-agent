// DLP badge + details popup for one agent turn. The summary is aggregate-only:
// classes, PII kinds and destination, never original values or token ids.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { openSubDialog } from "../subdialog.js";
import type { Dict } from "../core/store/types.js";

const CLASSES = ["path", "machine", "env", "secret", "pii", "file-content"] as const;

function num(value: unknown): number {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

function kindsOf(summary: Dict, dataClass: string): string[] {
  const kinds = summary.kinds;
  if (!kinds || typeof kinds !== "object") return [];
  const list = (kinds as Dict)[dataClass];
  return Array.isArray(list) ? list.map((k) => String(k)) : [];
}

function statsOf(summary: Dict, dataClass: string): number {
  const stats = summary.stats;
  if (!stats || typeof stats !== "object") return 0;
  return num((stats as Dict)[dataClass]);
}

function targetsOf(summary: Dict): Array<{ trusted: boolean; host?: string }> {
  if (!Array.isArray(summary.targets)) return [];
  return summary.targets
    .filter((x): x is Dict => !!x && typeof x === "object")
    .map((x) => ({ trusted: x.trusted === true, host: typeof x.host === "string" ? x.host : undefined }));
}

function detailsNode(summary: Dict): HTMLElement {
  const wrap = el("div", "dlp-details");
  const total = num(summary.total);
  wrap.appendChild(el("div", "dlp-total", t("web.dlp.total", { count: total })));
  if (total === 0) wrap.appendChild(el("div", "detail", t("web.dlp.empty")));

  for (const dataClass of CLASSES) {
    const count = statsOf(summary, dataClass);
    if (count <= 0) continue;
    const row = el("div", "dlp-row");
    row.appendChild(el("span", "dlp-class", t("web.dlp.class." + dataClass)));
    const kinds = kindsOf(summary, dataClass);
    // Секреты не имеют полезного публичного вида — не дублируем «Secrets (secret)».
    if (kinds.length && dataClass !== "secret") {
      row.appendChild(el("span", "dlp-kinds", t("web.dlp.kinds", { list: kinds.join(", ") })));
    }
    row.appendChild(el("b", "dlp-count", String(count)));
    wrap.appendChild(row);
  }

  const targets = targetsOf(summary);
  if (targets.length) {
    const row = el("div", "dlp-row dlp-target");
    row.appendChild(el("span", "dlp-class", t("web.dlp.destination")));
    for (const target of targets) {
      const label = target.trusted ? t("web.dlp.local") : t("web.dlp.external");
      row.appendChild(el("span", "dlp-host", target.host ? `${label}: ${target.host}` : label));
    }
    wrap.appendChild(row);
  }
  return wrap;
}

/** Badge for a turn footer; `total: 0` still renders (policy is on). */
export function egressBadge(summary: unknown): HTMLElement | null {
  if (!summary || typeof summary !== "object") return null;
  const data = summary as Dict;
  const total = num(data.total);
  const badge = el("button", "dlp-badge" + (total === 0 ? " clean" : ""));
  badge.type = "button";
  badge.textContent = t("web.dlp.badge", { count: total });
  badge.title = t("web.dlp.title");
  badge.addEventListener("click", (ev) => {
    ev.preventDefault();
    openSubDialog(t("web.dlp.title"), detailsNode(data));
  });
  return badge;
}
