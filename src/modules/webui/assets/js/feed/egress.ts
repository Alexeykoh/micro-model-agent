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
  return Array.isArray(list) ? list.map((k) => kindLabel(dataClass, String(k))) : [];
}

/** Понятная подпись вида находки; неизвестный вид показываем как есть. */
function kindLabel(dataClass: string, kind: string): string {
  const key = "web.dlp.kind." + kind;
  const label = t(key);
  if (label !== key) return label;
  if (kind.startsWith("env:")) return t("web.dlp.kind.env", { name: kind.slice(4) });
  return dataClass === "file-content" ? t("web.dlp.kind.file-content") : kind;
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

interface SecretKind {
  kind: string;
  count: number;
  previews: string[];
}

/** Детализация секретов из агрегата; старые записи истории её не имеют. */
function secretsOf(summary: Dict): SecretKind[] {
  if (!Array.isArray(summary.secrets)) return [];
  return summary.secrets
    .filter((x): x is Dict => !!x && typeof x === "object")
    .map((x) => ({
      kind: String(x.kind ?? ""),
      count: num(x.count),
      previews: Array.isArray(x.previews)
        ? x.previews.filter((p): p is string => typeof p === "string")
        : [],
    }))
    .filter((x) => x.kind && x.count > 0);
}

/** Публичный вид секрета; неизвестный вид показываем как есть. */
function secretKindLabel(kind: string): string {
  const key = "web.dlp.secretKind." + kind;
  const label = t(key);
  return label === key ? kind : label;
}

function secretRow(secret: SecretKind): HTMLElement {
  const row = el("div", "dlp-row dlp-secret");
  row.appendChild(el("span", "dlp-class", secretKindLabel(secret.kind)));
  if (secret.previews.length) {
    row.appendChild(el("span", "dlp-preview", secret.previews.join(", ")));
  }
  row.appendChild(el("b", "dlp-count", String(secret.count)));
  return row;
}

function detailsNode(summary: Dict): HTMLElement {
  const wrap = el("div", "dlp-details");
  const total = num(summary.total);
  wrap.appendChild(el("div", "dlp-total", t("web.dlp.total", { count: total })));
  if (total === 0) wrap.appendChild(el("div", "detail", t("web.dlp.empty")));

  const secrets = secretsOf(summary);
  for (const dataClass of CLASSES) {
    const count = statsOf(summary, dataClass);
    if (count <= 0) continue;
    const row = el("div", "dlp-row");
    row.appendChild(el("span", "dlp-class", t("web.dlp.class." + dataClass)));
    const kinds = kindsOf(summary, dataClass);
    // Секреты не имеют полезного публичного вида — раскрываем их ниже по типам.
    if (kinds.length && dataClass !== "secret") {
      row.appendChild(el("span", "dlp-kinds", t("web.dlp.kinds", { list: kinds.join(", ") })));
    }
    row.appendChild(el("b", "dlp-count", String(count)));
    wrap.appendChild(row);
    if (dataClass === "secret") {
      for (const secret of secrets) wrap.appendChild(secretRow(secret));
    }
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

/** Маленькая жёлтая иконка щита: без эмодзи, наследует цвет от `.dlp-badge`. */
function shieldIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "dlp-shield");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M8 1.5 13 3.1v4.1c0 3.2-2 5.7-5 7.3-3-1.6-5-4.1-5-7.3V3.1L8 1.5Z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}

/** Badge for a turn footer; `total: 0` still renders (policy is on). */
export function egressBadge(summary: unknown): HTMLElement | null {
  if (!summary || typeof summary !== "object") return null;
  const data = summary as Dict;
  const total = num(data.total);
  const badge = el("button", "dlp-badge" + (total === 0 ? " clean" : ""));
  badge.type = "button";
  const title = t("web.dlp.badgeTitle", { count: total });
  badge.title = title;
  badge.setAttribute("aria-label", title);
  badge.appendChild(shieldIcon());
  badge.appendChild(el("span", "dlp-label", t("web.dlp.badge")));
  badge.addEventListener("click", (ev) => {
    ev.preventDefault();
    openSubDialog(t("web.dlp.title"), detailsNode(data));
  });
  return badge;
}
