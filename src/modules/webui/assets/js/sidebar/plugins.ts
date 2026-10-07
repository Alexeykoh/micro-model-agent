// Plugins tab for `mma web`: list with live enable/disable toggles and a details
// popup. Split out of `sidebar.js`; leaf module (imports only dom/api/i18n/
// dialog/subdialog/sidebar-state), so the frontend DAG stays acyclic.
//
// Layout note: the sidebar is a fixed 679px, so this is NOT master-detail like
// Trace — a plain row list plus the existing nested `#subOverlay` popup, exactly
// how the LSP tab opens its info dialog.
import { el, icon, makeToggle } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { setIndicator } from "../dialog.js";
import { openSubDialog } from "../subdialog.js";
import type { Dict } from "../core/store/types.js";
import { sb } from "./state.js";

/**
 * Одна запись плагина из `GET /api/plugins`. Сервер — источник правды, поля
 * расширяются ядром, поэтому здесь намеренно свободная форма (то же, что
 * `Dict` в остальных вкладках).
 */
type PluginRow = Dict & { name: string; enabled: boolean };

let redrawPopup: (() => void) | null = null;

/** Глиф и класс состояния: включён / выключен / не загрузился / с предупреждениями. */
function pluginGlyph(row: PluginRow): [string, string] {
  if (!row.enabled) return ["–", "dim"];
  if ((row.warnings as string[] | undefined)?.length) return ["⚠", "warn"];
  return ["✓", "ok"];
}

/** Версия и автор — разными спанами: версия dim, автор акцентом. */
function rowMeta(row: PluginRow): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (row.version) frag.appendChild(el("span", "plg-ver", "v" + String(row.version)));
  if (row.author) {
    if (row.version) frag.appendChild(document.createTextNode(" · "));
    frag.appendChild(el("span", "plg-author", String(row.author)));
  }
  return frag;
}

/** Строка плагина: глиф, имя, мета, описание, тумблер. */
function pluginRow(row: PluginRow): HTMLElement {
  const node = el("div", "plg-row");
  const [glyph, cls] = pluginGlyph(row);
  node.appendChild(el("span", "plg-g " + cls, glyph));
  node.appendChild(el("span", "plg-name", row.name));
  node.appendChild(rowMeta(row));
  if (badges(row)) node.appendChild(el("span", "plg-badges", badges(row)));

  const toggle = makeToggle(!!row.enabled, (next) => {
    void togglePlugin(row.name, next);
    return false; // состояние перерисовывается из ответа сервера
  });
  toggle.title = t(row.enabled ? "web.plugins.disable" : "web.plugins.enable");
  toggle.setAttribute("aria-label", t(row.enabled ? "web.plugins.disable" : "web.plugins.enable"));
  node.appendChild(toggle);

  node.addEventListener("click", () => openPluginDialog(row));
  return node;
}

/** Чипсы источника/черновика: `builtin`, `project`, `draft`. */
function badges(row: PluginRow): string {
  const out: string[] = [];
  if (row.draft) out.push(t("web.plugins.badge_draft"));
  else if (row.builtin) out.push(t("web.plugins.badge_builtin"));
  else if (row.source) out.push(String(row.source));
  return out.join(" · ");
}

/** Тумблер: `POST /api/plugins/:name {enabled}` — живо, без рестарта. */
async function togglePlugin(name: string, on: boolean): Promise<void> {
  const res = await api<Dict>("/api/plugins/" + encodeURIComponent(name), {
    method: "POST",
    body: { enabled: on },
  });
  if (!res.ok || !res.data || res.data.ok !== true) {
    const err = (res.data && (res.data.error as string)) || String(res.status);
    setIndicator(err === "not_found" ? t("cli.plugins.not_found", { name }) : t("web.plugins.toggle_failed"), true);
    return;
  }
  adopt(res.data);
  renderPlugins();
  redrawPopup?.();
}

/** Принять свежие записи/отказы из ответа (истина — сервер). */
function adopt(payload: Dict): void {
  const records = (payload.plugins as PluginRow[] | undefined) || [];
  sb.plugins.records = records;
  sb.plugins.failures = (payload.failures as Dict[]) || [];
}

/** Дима-строка описания под строкой. */
function descriptionLine(row: PluginRow): HTMLElement | null {
  const text = String(row.description || "").trim();
  if (!text) return null;
  const line = el("div", "plg-desc", text.length > 90 ? text.slice(0, 89) + "…" : text);
  return line;
}

function renderSummary(host: HTMLElement): void {
  const records = sb.plugins.records;
  const off = records.filter((r) => !r.enabled).length;
  const failed = sb.plugins.failures.length;
  const active = records.length - off;
  const parts = [t("web.plugins.summary", { active: String(active), off: String(off) })];
  if (failed > 0) parts.push(t("web.plugins.failed_count", { count: String(failed) }));
  host.appendChild(el("div", "plg-summary", parts.join(" · ")));
}

function renderFailures(host: HTMLElement): void {
  for (const failure of sb.plugins.failures) {
    const row = el("div", "plg-row plg-broken");
    row.appendChild(el("span", "plg-g fail", "✗"));
    row.appendChild(el("span", "plg-name", String(failure.entry || failure.path || "?")));
    row.appendChild(el("span", "plg-meta", String(failure.message || "")));
    host.appendChild(row);
  }
}

/** Полный пересбор панели. */
export function renderPlugins(): void {
  const host = sb.plugins.bodyEl;
  if (!host) return;
  host.textContent = "";

  if (sb.plugins.unavailable) {
    host.appendChild(el("div", "fdim", t("web.plugins.unavailable")));
    return;
  }
  if (!sb.plugins.loaded) {
    host.appendChild(el("div", "fdim", t("web.plugins.loading")));
    return;
  }

  renderSummary(host);
  const rows = sb.plugins.records;
  if (rows.length === 0 && sb.plugins.failures.length === 0) {
    host.appendChild(el("div", "fdim", t("web.plugins.empty")));
  }
  // Встроенные — после внешних: пользователю важны свои плагины.
  const ordered = (rows as PluginRow[]).sort(
    (a, b) => Number(!!a.builtin) - Number(!!b.builtin),
  );
  for (const row of ordered) {
    host.appendChild(pluginRow(row));
    const desc = descriptionLine(row);
    if (desc) host.appendChild(desc);
  }
  renderFailures(host);
}

/** Попап «подробности»: описание, автор, версия, путь, что добавляет, права. */
export function openPluginDialog(row: PluginRow): void {
  const box = el("div", "plg-info");
  redrawPopup = () => drawPluginInfo(box, row);
  redrawPopup();
  openSubDialog(String(row.name), box, () => {
    redrawPopup = null;
  });
}

function detailRow(label: string, value: string): HTMLElement {
  const row = el("div", "kv");
  row.appendChild(el("span", "dim", label));
  row.appendChild(el("b", "", value));
  return row;
}

/** Ссылка на homepage: только http(s), `noopener` (как в веб-сайте). */
function homepageLink(url: string): HTMLElement {
  const link = el("a", "plg-link");
  link.href = url;
  link.textContent = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

/** Строка `<code>путь</code> + кнопка копирования`. */
function pathRow(path: string): HTMLElement {
  const row = el("div", "lsp-install");
  row.appendChild(el("code", "lsp-cmd", path));
  const copy = el("button", "linkbtn lsp-copy");
  copy.type = "button";
  copy.title = t("web.plugins.copy_path");
  copy.setAttribute("aria-label", t("web.plugins.copy_path"));
  copy.appendChild(icon("copy"));
  copy.addEventListener("click", () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(path).then(() => setIndicator(t("web.plugins.copied"), false)).catch(() => {});
    }
  });
  row.appendChild(copy);
  return row;
}

function chipRow(label: string, values: string[]): HTMLElement | null {
  if (values.length === 0) return null;
  const wrap = el("div", "plg-chips");
  wrap.appendChild(el("span", "dim", label));
  // `.plg-tag`, а не `.chip`: тот оформлен как кликабельная кнопка, а тут
  // перечисление — читаемое, не интерактивное.
  for (const value of values) wrap.appendChild(el("span", "plg-tag", value));
  return wrap;
}

function drawPluginInfo(box: HTMLElement, row: PluginRow): void {
  box.textContent = "";

  const head = el("div", "kv");
  head.appendChild(el("span", "dim", t("web.plugins.state")));
  head.appendChild(
    el("b", "", t(row.enabled ? "cli.plugins.on" : "cli.plugins.off") + " · " + (row.source || "builtin")),
  );
  box.appendChild(head);

  const toggleRow = el("div", "kv lsp-toggle");
  toggleRow.appendChild(el("span", "dim", t("web.plugins.switch_enabled")));
  const toggle = makeToggle(!!row.enabled, (next) => {
    void togglePlugin(row.name, next);
    return false;
  });
  toggle.title = t("web.plugins.switch_enabled");
  toggleRow.appendChild(toggle);
  box.appendChild(toggleRow);

  box.appendChild(el("div", "plg-desc-block", String(row.description || t("web.plugins.no_description"))));

  if (row.author) box.appendChild(detailRow(t("cli.plugins.author"), String(row.author)));
  if (row.version) box.appendChild(detailRow(t("web.plugins.version"), "v" + String(row.version)));
  if (row.homepage) {
    const rowHome = el("div", "kv");
    rowHome.appendChild(el("span", "dim", t("cli.plugins.homepage")));
    rowHome.appendChild(homepageLink(String(row.homepage)));
    box.appendChild(rowHome);
  }

  const provides = (row.provides || {}) as { tools?: string[]; hooks?: string[] };
  const toolsChips = chipRow(t("web.plugins.tools"), provides.tools || []);
  const hooksChips = chipRow(t("web.plugins.hooks"), provides.hooks || []);
  if (toolsChips) box.appendChild(toolsChips);
  if (hooksChips) box.appendChild(hooksChips);
  // Переключение плагина с тулами меняет набор тулов между итерациями — префикс
  // промпта рвётся и кеш провайдера сбрасывается. Говорим об этом прямо.
  if ((provides.tools || []).length > 0) {
    box.appendChild(el("div", "plg-hint", t("web.plugins.cache_note")));
  }

  const permissions = (row.permissions as string[] | undefined) || [];
  box.appendChild(
    permissions.length > 0
      ? detailRow(t("cli.plugins.perms_label"), permissions.join(", "))
      : el("div", "plg-hint", t("web.plugins.permissions_none")),
  );
  box.appendChild(el("div", "plg-hint", t("web.plugins.permissions_hint")));

  const warnings = (row.warnings as string[] | undefined) || [];
  if (warnings.length > 0) {
    box.appendChild(el("div", "plg-warn-title", t("web.plugins.warnings")));
    for (const warning of warnings) box.appendChild(el("div", "plg-hint warn", String(warning)));
  }
  if (row.path) box.appendChild(pathRow(String(row.path)));
}

/** Ленивая загрузка вкладки: дёргается только когда вкладка активна. */
export function sidebarPluginsState(): void {
  if (sb.active !== "plugins" || sb.plugins.unavailable) return;
  if (!sb.plugins.loaded) void loadPlugins();
}

/** Первичная загрузка (`GET /api/plugins`). */
async function loadPlugins(): Promise<void> {
  const res = await api<Dict>("/api/plugins");
  if (!res.ok || !res.data) {
    sb.plugins.unavailable = true;
    sb.plugins.loaded = true;
    renderPlugins();
    return;
  }
  sb.plugins.unavailable = false;
  sb.plugins.loaded = true;
  adopt(res.data);
  renderPlugins();
}

/** SSE `plugins`: реестр изменился в другом месте — перечитываем. */
export function sidebarPluginsEvent(): void {
  if (sb.active !== "plugins") return;
  void loadPlugins();
}
