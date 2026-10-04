// LSP tab for `mma web`: on-demand language-server diagnosis. Split out of
// `sidebar.js`. Design: docs/specs/2026-10-02-lsp-doctor-design.md (§12).
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { formatMs } from "../format.js";
import { sb } from "./state.js";
import { mapKv } from "./map.js";

/** i18n-ключ ярлыка класса причины (`not-applicable` → `..._not_applicable`). */
function lspReasonKey(reason) {
  return "web.sidebar.lsp_reason_" + String(reason || "").replace(/-/g, "_");
}

/** Глиф и класс строки сервера по классу причины. */
function lspGlyph(reason) {
  if (reason === "ok") return ["✓", "ok"];
  if (reason === "disabled" || reason === "not-applicable" || reason === "deadline") return ["–", "dim"];
  return ["✗", "fail"];
}

/** Хвост-detail строки сервера (время/способ запуска/бинарник/ошибка). */
function lspDetail(s) {
  if (s.reason === "ok") {
    const via = s.useNpxFallback ? t("web.sidebar.lsp_via_npx") : t("web.sidebar.lsp_via_global");
    return formatMs(s.durationMs || 0) + " · " + t("web.sidebar.lsp_via") + " " + via;
  }
  if (s.reason === "binary-missing" || s.reason === "offline" || s.reason === "network") {
    return s.binaryName || s.command || "";
  }
  if (s.reason === "spawn-failed" || s.reason === "server-error") {
    return String(s.error || "").split("\n")[0];
  }
  return "";
}

function lspRow(s) {
  const row = el("div", "kv lsp-row");
  row.appendChild(el("span", "dim", s.language));
  const b = el("b");
  const [g, cls] = lspGlyph(s.reason);
  b.appendChild(el("span", "lsp-g " + cls, g));
  b.appendChild(document.createTextNode(" " + t(lspReasonKey(s.reason))));
  const detail = lspDetail(s);
  if (detail) b.appendChild(el("span", "lsp-detail", " · " + detail));
  row.appendChild(b);
  return row;
}

export function renderLsp() {
  if (!sb.lspEl) return;
  sb.lspEl.textContent = "";
  sb.lspEl.appendChild(el("div", "lsp-what", t("web.sidebar.lsp_what")));
  if (sb.lspUnavailable) {
    sb.lspEl.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_unavailable")));
    return;
  }
  if (sb.lspProbing) {
    sb.lspEl.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_checking")));
  } else if (!sb.lspDiag) {
    sb.lspEl.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_not_checked")));
  } else {
    const onOff = (v) => (v ? t("web.sidebar.map_on") : t("web.sidebar.map_off"));
    sb.lspEl.appendChild(mapKv(t("web.sidebar.lsp_enabled"), onOff(sb.lspDiag.enabled)));
    sb.lspEl.appendChild(mapKv(t("web.sidebar.lsp_offline"), onOff(sb.lspDiag.offline)));
    const servers = Array.isArray(sb.lspDiag.servers) ? sb.lspDiag.servers : [];
    if (servers.length === 0) {
      sb.lspEl.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_none")));
    } else {
      servers.forEach((s) => sb.lspEl.appendChild(lspRow(s)));
    }
  }
  const btn = el(
    "button",
    "map-reindex",
    sb.lspProbing ? t("web.sidebar.lsp_checking") : t("web.sidebar.lsp_check"),
  );
  btn.type = "button";
  btn.disabled = sb.lspProbing || sb.lspUnavailable;
  btn.addEventListener("click", () => void runLspDoctor());
  sb.lspEl.appendChild(btn);
}

/** Загрузить кэш диагностики с сервера; при пустом кэше — запустить проверку. */
async function loadLspDoctor() {
  const r = await api("/api/lsp/doctor");
  if (!r.ok) {
    sb.lspUnavailable = true;
    sb.lspProbing = false;
    renderLsp();
    return;
  }
  sb.lspUnavailable = false;
  sb.lspDiag = (r.data && r.data.diagnosis) || null;
  sb.lspProbing = !!(r.data && r.data.probing);
  sb.lspLoaded = true;
  renderLsp();
  if (sb.lspDiag === null && !sb.lspProbing) void runLspDoctor();
}

/** Запустить диагностику (fire-and-forget; результат придёт по SSE `lsp`). */
async function runLspDoctor() {
  if (sb.lspUnavailable || sb.lspProbing) return;
  sb.lspProbing = true;
  renderLsp();
  const r = await api("/api/lsp/doctor", { method: "POST" });
  if (r.status === 503) {
    sb.lspUnavailable = true;
    sb.lspProbing = false;
    renderLsp();
  }
}

/**
 * Ленивая загрузка вкладки LSP: срабатывает только когда вкладка активна.
 * Зовётся из `renderState` (2с-полл) и при переключении вкладки.
 */
export function sidebarLspState() {
  if (sb.active !== "lsp" || sb.lspUnavailable) return;
  if (!sb.lspLoaded) {
    void loadLspDoctor();
  } else if (sb.lspDiag === null && !sb.lspProbing) {
    void runLspDoctor();
  }
}

/** SSE `lsp`: `start` — показать проверку, `done`/`error` — перечитать результат. */
export function sidebarLspEvent(d) {
  if (!d) return;
  if (d.phase === "start") {
    sb.lspProbing = true;
    renderLsp();
    return;
  }
  void loadLspDoctor();
}
