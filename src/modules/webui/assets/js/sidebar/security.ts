// Вкладка «Безопасность» (U22): живой журнал отловов защиты.
// Источники: SSE `security` (live) и GET /api/sessions/:id/security (бэкфилл из
// audit.jsonl + буфер процесса). Свежее — сверху; при чтении истории автоскролл
// не дёргает (прилипание только у верхней кромки).
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import { openSubDialog } from "../subdialog.js";
import type { Dict } from "../core/store/types.js";

/** Классы событий в порядке фильтров. */
const CLASSES = ["block", "dlp", "approval", "ssrf"] as const;

const SEC_CAP = 200;

const sec = {
  items: [] as Dict[],
  filter: "all" as string,
  sid: null as string | null,
  loading: false,
  unread: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Ключ дедупликации: одно событие из SSE и из бэкфилла — не два. */
function keyOf(ev: Dict): string {
  return [str(ev.ts), str(ev.action), str(ev.tool), str(ev.url) || str(ev.path) || str(ev.command)].join("\0");
}

/** Время события в локальном формате (null — нет валидной метки). */
function timeOf(ev: Dict): string {
  const ts = Date.parse(str(ev.ts));
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString();
}

function classLabel(cls: string): string {
  const key = "web.security.class." + cls;
  const label = t(key);
  return label === key ? cls : label;
}

function classGlyph(cls: string): string {
  if (cls === "dlp") return "🛡";
  if (cls === "ssrf") return "⇄";
  if (cls === "approval") return "✋";
  return "⊘";
}

function listEl(): HTMLElement | null {
  return document.getElementById("securityList");
}

function badgeEl(): Element | null {
  return document.querySelector('.sb-tab[data-tab="security"] .sb-dot');
}

function markUnread(): void {
  const tab = document.querySelector('.sb-tab[data-tab="security"]');
  if (!tab || tab.classList.contains("on")) return;
  sec.unread += 1;
  const dot = badgeEl();
  if (dot) dot.setAttribute("data-indicator", "live");
}

function clearUnread(): void {
  sec.unread = 0;
  const dot = badgeEl();
  if (dot) dot.removeAttribute("data-indicator");
}

/** Детали одного отлова для поп-апа. */
function detailsNode(ev: Dict): HTMLElement {
  const wrap = el("div", "secd-details");
  const rows: Array<[string, string]> = [
    [t("web.security.when"), str(ev.ts)],
    [t("web.security.class_label"), classLabel(str(ev.class))],
    [t("web.security.action"), str(ev.action)],
    ...(str(ev.tool) ? [[t("web.security.tool"), str(ev.tool)]] as Array<[string, string]> : []),
    ...(str(ev.path) ? [[t("web.security.path"), str(ev.path)]] as Array<[string, string]> : []),
    ...(str(ev.command) ? [[t("web.security.command"), str(ev.command)]] as Array<[string, string]> : []),
    ...(str(ev.url) ? [[t("web.security.url"), str(ev.url)]] as Array<[string, string]> : []),
    ...(str(ev.reason) ? [[t("web.security.reason"), str(ev.reason)]] as Array<[string, string]> : []),
    ...(str(ev.details) ? [[t("web.security.details"), str(ev.details)]] as Array<[string, string]> : []),
    ...(str(ev.sessionId) ? [[t("web.security.session"), str(ev.sessionId)]] as Array<[string, string]> : []),
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = el("div", "secd-row");
    row.appendChild(el("span", "secd-lab", label));
    row.appendChild(el("span", "secd-val", value));
    wrap.appendChild(row);
  }
  return wrap;
}

function rowNode(ev: Dict): HTMLElement {
  const cls = str(ev.class) || "block";
  const row = el("button", "spec-row sev-" + (str(ev.severity) || "low"));
  row.type = "button";
  row.appendChild(el("span", "spec-g", classGlyph(cls)));
  row.appendChild(el("span", "spec-t", timeOf(ev)));
  row.appendChild(el("span", "spec-class", classLabel(cls)));
  row.appendChild(el("span", "spec-sum", str(ev.summary) || cls));
  row.addEventListener("click", (e) => {
    e.preventDefault();
    openSubDialog(classLabel(cls), detailsNode(ev));
  });
  return row;
}

/** Перерисовать список по текущему фильтру (свежее сверху). */
export function renderSecurityList(): void {
  const list = listEl();
  if (!list) return;
  const pinned = list.scrollTop <= 4;
  list.textContent = "";
  const visible = sec.items.filter((ev) => sec.filter === "all" || str(ev.class) === sec.filter);
  if (visible.length === 0) {
    list.appendChild(el("div", "sec-empty", t("web.security.empty")));
    return;
  }
  for (const ev of visible) list.appendChild(rowNode(ev));
  if (pinned) list.scrollTop = 0;
}

/** Добавить события (live или бэкфилл), без дублей, с капом. */
function addEvents(events: Dict[]): void {
  const known = new Set(sec.items.map(keyOf));
  let added = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const key = keyOf(ev);
    if (known.has(key)) continue;
    known.add(key);
    sec.items.push(ev);
    added += 1;
  }
  if (added === 0) return;
  sec.items.sort((a, b) => (Date.parse(str(b.ts)) || 0) - (Date.parse(str(a.ts)) || 0));
  if (sec.items.length > SEC_CAP) sec.items.length = SEC_CAP;
  renderSecurityList();
}

function filtersNode(): HTMLElement | null {
  return document.getElementById("securityFilters");
}

function renderFilters(): void {
  const host = filtersNode();
  if (!host) return;
  host.textContent = "";
  const options = ["all", ...CLASSES] as const;
  for (const cls of options) {
    const btn = el("button", "chip-link" + (sec.filter === cls ? " on" : ""));
    btn.type = "button";
    btn.textContent = cls === "all" ? t("web.security.filter_all") : classLabel(cls);
    btn.addEventListener("click", () => {
      sec.filter = cls;
      renderFilters();
      renderSecurityList();
    });
    host.appendChild(btn);
  }
}

/** Событие из SSE `security`. */
export function sidebarSecurityEvent(data: Dict): void {
  const ev = data.event;
  if (!ev || typeof ev !== "object") return;
  const sid = str(data.sessionId) || str((ev as Dict).sessionId);
  if (sid && sec.sid && sid !== sec.sid) return;
  addEvents([ev as Dict]);
  markUnread();
}

/** Загрузить историю сессии (бэкфилл) — один раз на сессию. */
export async function sidebarSecurityPull(): Promise<void> {
  const sid = sec.sid;
  if (!sid || sec.loading) return;
  sec.loading = true;
  try {
    const r = await api<{ events?: Dict[] }>(
      "/api/sessions/" + encodeURIComponent(sid) + "/security?limit=100",
    );
    const events = Array.isArray(r.data?.events) ? r.data.events : [];
    addEvents(events);
  } catch {
    /* нет истории — не ошибка для панели */
  } finally {
    sec.loading = false;
  }
}

/** Смена сессии: сброс буфера и бэкфилл новой (sid берём из `.sb[data-sid]`). */
export function sidebarSecuritySessionChanged(): void {
  const sid = document.querySelector(".sb")?.getAttribute("data-sid") || "";
  sec.items = [];
  sec.sid = sid || null;
  sec.filter = "all";
  clearUnread();
  renderFilters();
  renderSecurityList();
  void sidebarSecurityPull();
}

/** Открытие вкладки: снимаем непрочитанное и дожимаем историю. */
export function sidebarSecurityState(): void {
  clearUnread();
  renderFilters();
  renderSecurityList();
  void sidebarSecurityPull();
}

/** Инициализация панели (один раз при старте UI). */
export function initSecurityPanel(): void {
  renderFilters();
  renderSecurityList();
}
