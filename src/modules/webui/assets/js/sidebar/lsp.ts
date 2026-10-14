// LSP tab for `mma web`: on-demand language-server diagnosis. Split out of
// `sidebar.js`. Design: docs/specs/2026-10-02-lsp-doctor-design.md (§12).
import { el, icon, makeToggle } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { formatMs } from "../format.js";
import { setIndicator } from "../dialog.js";
import { openSubDialog } from "../subdialog.js";
import type { Dict } from "../core/store/types.js";
import { sb } from "./state.js";
import { mapKv } from "./map.js";
import { appendToolchain } from "./lsp-toolchain.js";

/** i18n-ключ ярлыка класса причины (`not-applicable` → `..._not_applicable`). */
function lspReasonKey(reason: unknown): string {
  return "web.sidebar.lsp_reason_" + String(reason || "").replace(/-/g, "_");
}

/** Глиф и класс строки сервера по классу причины. */
function lspGlyph(reason: string | undefined): [string, string] {
  if (reason === "ok") return ["✓", "ok"];
  if (reason === "disabled" || reason === "not-applicable" || reason === "deadline") return ["–", "dim"];
  return ["✗", "fail"];
}

// Причины, которые не заслуживают отдельной строки: сервер либо не применим к
// проекту, либо выключен. Схлопываем их в одну dim-строку на причину.
const MUTED_REASONS = new Set(["not-applicable", "disabled"]);

/** Хвост-detail строки сервера (время/способ запуска/бинарник/ошибка). */
function lspDetail(s: Dict): string {
  if (s.reason === "ok") {
    const parts: string[] = [];
    const ms = formatMs(s.durationMs || 0);
    if (ms) parts.push(ms);
    if (s.useNpxFallback) parts.push(t("web.sidebar.lsp_via_npx"));
    return parts.join(" · ");
  }
  if (s.reason === "binary-missing" || s.reason === "offline" || s.reason === "network") {
    return s.binaryName || s.command || "";
  }
  if (s.reason === "spawn-failed" || s.reason === "server-error") {
    return String(s.error || "").split("\n")[0];
  }
  return "";
}

function lspRow(s: Dict): HTMLElement {
  const row = el("div", "lsp-row");
  row.appendChild(el("span", "lsp-lang", s.language));
  const st = el("span", "lsp-status");
  const [g, cls] = lspGlyph(s.reason);
  st.appendChild(el("span", "lsp-g " + cls, g));
  st.appendChild(document.createTextNode(" " + t(lspReasonKey(s.reason))));
  const detail = lspDetail(s);
  if (detail) st.appendChild(document.createTextNode(" · " + detail));
  if (s.reason === "ok") {
    const via = s.useNpxFallback ? t("web.sidebar.lsp_via_npx") : t("web.sidebar.lsp_via_global");
    row.title = t("web.sidebar.lsp_via") + " " + via;
  }
  row.appendChild(st);
  return row;
}

/** Одна dim-строка на причину: `javascript, python, …` + статус снизу. */
function lspMutedRow(reason: string, list: Dict[]): HTMLElement {
  const row = el("div", "lsp-row lsp-muted");
  const langs = el("span", "lsp-lang", list.map((s) => s.language).join(", "));
  langs.title = langs.textContent;
  row.appendChild(langs);
  const st = el("span", "lsp-status");
  const [g, cls] = lspGlyph(reason);
  st.appendChild(el("span", "lsp-g " + cls, g));
  st.appendChild(document.createTextNode(" " + t(lspReasonKey(reason))));
  row.appendChild(st);
  return row;
}

export function renderLsp(): void {
  const host = sb.lspEl;
  if (!host) return;
  host.textContent = "";
  const head = el("div", "lsp-head");
  head.appendChild(el("span", "lsp-what", t("web.sidebar.lsp_what")));
  const infoBtn = el("button", "lsp-info-btn");
  infoBtn.type = "button";
  infoBtn.title = t("web.sidebar.lsp_info");
  infoBtn.setAttribute("aria-label", t("web.sidebar.lsp_info"));
  infoBtn.appendChild(icon("info"));
  infoBtn.addEventListener("click", openLspInfoDialog);
  head.appendChild(infoBtn);
  host.appendChild(head);

  if (sb.lspUnavailable) {
    host.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_unavailable")));
    return;
  }
  if (sb.lspProbing) {
    host.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_checking")));
  } else if (!sb.lspDiag) {
    host.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_not_checked")));
  } else {
    const onOff = (v: unknown) => (v ? t("web.sidebar.map_on") : t("web.sidebar.map_off"));
    const diag = sb.lspDiag;
    const enabled = diag.enabled;
    const flags = el("div", "lsp-row lsp-flags");
    flags.appendChild(el("span", "lsp-lang", "LSP"));
    const st = el("span", "lsp-status");
    st.appendChild(el("span", "lsp-g " + (enabled ? "ok" : "dim"), enabled ? "✓" : "–"));
    st.appendChild(
      document.createTextNode(
        " " + (enabled ? t("web.sidebar.lsp_enabled") : t("web.sidebar.lsp_reason_disabled")),
      ),
    );
    if (diag.offline) {
      st.appendChild(document.createTextNode(" · " + t("web.sidebar.lsp_offline") + " " + onOff(true)));
    }
    flags.appendChild(st);
    host.appendChild(flags);
    appendToolchain(host, diag.toolchain);
    const servers: Dict[] = Array.isArray(diag.servers) ? diag.servers : [];
    if (servers.length === 0) {
      host.appendChild(mapKv(t("web.sidebar.lsp_status"), t("web.sidebar.lsp_none")));
    } else {
      const active: Dict[] = [];
      const muted = new Map<string, Dict[]>();
      servers.forEach((s: Dict) => {
        if (MUTED_REASONS.has(s.reason)) {
          if (!muted.has(s.reason)) muted.set(s.reason, []);
          muted.get(s.reason)?.push(s);
        } else {
          active.push(s);
        }
      });
      active.forEach((s) => host.appendChild(lspRow(s)));
      muted.forEach((list, reason) => host.appendChild(lspMutedRow(reason, list)));
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
  host.appendChild(btn);
}

/** Информационный поп-ап: глобальные тумблеры + команды ручной установки. */
let lspInfoRedraw: (() => void) | null = null;

function openLspInfoDialog(): void {
  const box = el("div", "lsp-info");
  lspInfoRedraw = () => drawLspInfo(box);
  lspInfoRedraw();
  openSubDialog(t("web.sidebar.lsp_info"), box, () => {
    lspInfoRedraw = null;
  });
}

/** Перерисовать содержимое поп-апа (после тумблера или свежего диагноза). */
function drawLspInfo(box: HTMLElement): void {
  box.textContent = "";
  const flags: { enabled: boolean; offline: boolean } | null =
    sb.lspFlags || (sb.lspDiag ? { enabled: sb.lspDiag.enabled, offline: sb.lspDiag.offline } : null);
  if (!flags) {
    box.appendChild(el("div", "lsp-hint", t("web.sidebar.lsp_not_checked")));
    return;
  }
  const onRow = el("div", "kv lsp-toggle");
  onRow.appendChild(el("span", "dim", t("web.sidebar.lsp_switch_enabled")));
  const on = makeToggle(flags.enabled, (next) => {
    void setLspFlag("lsp.enabled", next);
    return false;
  });
  on.title = t("web.sidebar.lsp_switch_enabled");
  onRow.appendChild(on);
  box.appendChild(onRow);

  const offRow = el("div", "kv lsp-toggle");
  offRow.appendChild(el("span", "dim", t("web.sidebar.lsp_switch_offline")));
  const off = makeToggle(flags.offline, (next) => {
    void setLspFlag("lsp.offline", next);
    return false;
  });
  off.title = t("web.sidebar.lsp_switch_offline");
  offRow.appendChild(off);
  box.appendChild(offRow);
  box.appendChild(el("div", "lsp-hint", t("web.sidebar.lsp_offline_hint")));

  const servers: Dict[] = (sb.lspDiag && Array.isArray(sb.lspDiag.servers) ? sb.lspDiag.servers : []).filter(
    (s: Dict) => s.installCommand,
  );
  if (!servers.length) return;
  box.appendChild(el("div", "lsp-install-title", t("web.sidebar.lsp_install_title")));
  servers.forEach((s: Dict) => {
    const row = el("div", "lsp-install");
    row.appendChild(el("span", "dim", s.language));
    row.appendChild(el("code", "lsp-cmd", s.installCommand));
    const copy = el("button", "linkbtn lsp-copy");
    copy.type = "button";
    copy.title = t("web.sidebar.lsp_copy");
    copy.setAttribute("aria-label", t("web.sidebar.lsp_copy"));
    copy.appendChild(icon("copy"));
    copy.addEventListener("click", () => copyCommand(s.installCommand, copy));
    row.appendChild(copy);
    box.appendChild(row);
  });
}

/** Переключить глобальный флаг LSP через единый путь записи `/api/config`. */
async function setLspFlag(key: string, value: unknown): Promise<void> {
  const r = await api<{ ok?: boolean; error?: string; reason?: string }>("/api/config", {
    method: "POST",
    body: { key, value },
  });
  if (!r.ok || !r.data || !r.data.ok) {
    const err = (r.data && (r.data.error || r.data.reason)) || String(r.status);
    setIndicator(err === "busy" ? t("web.sidebar.lsp_busy") : t("web.settings.save_failed"), true);
    return;
  }
  const field = key === "lsp.enabled" ? "enabled" : "offline";
  sb.lspFlags = { ...(sb.lspFlags || { enabled: true, offline: false }), [field]: value };
  sb.lspDiag = null;
  lspInfoRedraw?.();
  void runLspDoctor();
}

function copyCommand(text: string, btn: HTMLElement): void {
  const setIcon = (name: string) => {
    btn.textContent = "";
    btn.appendChild(icon(name));
  };
  const done = () => {
    setIcon("check");
    setTimeout(() => setIcon("copy"), 1500);
  };
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(done).catch(() => {});
  }
}

/** Загрузить кэш диагностики с сервера; при пустом кэше — запустить проверку. */
async function loadLspDoctor(): Promise<void> {
  const r = await api<{ diagnosis?: Dict; probing?: boolean; flags?: { enabled: boolean; offline: boolean } }>(
    "/api/lsp/doctor",
  );
  if (!r.ok) {
    sb.lspUnavailable = true;
    sb.lspProbing = false;
    renderLsp();
    return;
  }
  sb.lspUnavailable = false;
  sb.lspDiag = (r.data && r.data.diagnosis) || null;
  sb.lspProbing = !!(r.data && r.data.probing);
  sb.lspFlags = (r.data && r.data.flags) || sb.lspFlags;
  sb.lspLoaded = true;
  renderLsp();
  lspInfoRedraw?.();
  if (sb.lspDiag === null && !sb.lspProbing) void runLspDoctor();
}

/** Запустить диагностику (fire-and-forget; результат придёт по SSE `lsp`). */
async function runLspDoctor(): Promise<void> {
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
 * Зовётся из `renderActiveState` (SSE `state`) и при переключении вкладки.
 */
export function sidebarLspState(): void {
  if (sb.active !== "lsp" || sb.lspUnavailable) return;
  if (!sb.lspLoaded) {
    void loadLspDoctor();
  } else if (sb.lspDiag === null && !sb.lspProbing) {
    void runLspDoctor();
  }
}

/** SSE `lsp`: `start` — показать проверку, `done`/`error` — перечитать результат. */
export function sidebarLspEvent(d: Dict | null): void {
  if (!d) return;
  if (d.phase === "start") {
    sb.lspProbing = true;
    renderLsp();
    return;
  }
  void loadLspDoctor();
}
