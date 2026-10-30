// Секция «изменённые» вкладки LSP: `POST /api/lsp/check-changed`.
//
// Не обходит проект: сервер берёт `git status` (до 20 файлов), проверяет их
// последовательно с общим бюджетом. Здесь — кнопка, группировка по файлам и
// переход к строке (тот же `hooks.openFileAtLine`, что у одной диагностики).
import { el, icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { hooks } from "../store.js";
import { sb } from "./state.js";
import { fixButton } from "./lsp-fix.js";

const SHOW_LIMIT = 200;
let result: Dict | null = null;
let busy = false;

function diagRow(file: string, d: Dict): HTMLElement {
  const line = Number(d.line) || 1;
  const row = el(
    "button",
    "lsp-file-diag sev-" + String(d.severity || "info"),
  ) as HTMLButtonElement;
  row.type = "button";
  row.title = t("web.sidebar.lsp_file_open_line", { path: file, line: String(line) });
  row.setAttribute("aria-label", row.title);
  row.appendChild(el("span", "lsp-diag-pos", `${line}:${Number(d.column) || 1}`));
  const glyph = d.severity === "error" ? "✗" : d.severity === "warning" ? "!" : "i";
  row.appendChild(el("span", "lsp-diag-sev " + (d.severity === "error" ? "err" : "warn"), glyph));
  row.appendChild(el("span", "lsp-diag-msg", String(d.message || "")));
  row.addEventListener("click", () => hooks.openFileAtLine?.(file, line));
  return row;
}

export function renderChangedResult(box: HTMLElement, res: Dict): void {
  if (res.ok !== true) {
    const key = "web.sidebar.lsp_changed_" + String(res.error || "failed").replace(/-/g, "_");
    const text = t(key);
    box.appendChild(
      el("div", "lsp-hint", text === key ? t("web.sidebar.lsp_changed_failed") : text),
    );
    return;
  }
  const files = Array.isArray(res.files) ? (res.files as Dict[]) : [];
  let shown = 0;
  for (const f of files) {
    const file = String(f.path || "");
    const diags = Array.isArray(f.diagnostics) ? (f.diagnostics as Dict[]) : [];
    if (f.ok !== true) {
      box.appendChild(
        el(
          "div",
          "lsp-hint warn",
          `${file}: ${String(f.error || t("web.sidebar.lsp_changed_failed"))}`,
        ),
      );
      continue;
    }
    if (diags.length === 0) continue;
    const head = el("button", "lsp-changed-file") as HTMLButtonElement;
    head.type = "button";
    head.title = t("web.sidebar.lsp_changed_open", { path: file });
    head.appendChild(el("span", "lsp-file-name", file));
    head.appendChild(el("span", "lsp-diag-pos", String(diags.length)));
    head.addEventListener("click", () => hooks.openFileAtLine?.(file, Number(diags[0]?.line) || 1));
    box.appendChild(head);
    box.appendChild(fixButton(file, diags));
    for (const d of diags) {
      if (shown >= SHOW_LIMIT) break;
      box.appendChild(diagRow(file, d));
      shown++;
    }
    if (shown >= SHOW_LIMIT) break;
  }
  const clean = files.filter((f) => f.ok === true && (f.diagnostics as Dict[]).length === 0).length;
  if (shown === 0) {
    box.appendChild(
      el(
        "div",
        "lsp-file-state ok",
        "✓ " + t("web.sidebar.lsp_changed_clean", { count: String(clean) }),
      ),
    );
  }
  if (res.truncated) box.appendChild(el("div", "lsp-hint", t("web.sidebar.lsp_changed_truncated")));
}

/** Перерисовать секцию (без запроса). */
export function renderLspChanged(host: HTMLElement): void {
  let box = host.querySelector(".lsp-changed") as HTMLElement | null;
  if (!box) {
    box = el("div", "lsp-changed");
    host.appendChild(box);
  }
  box.textContent = "";
  const head = el("div", "lsp-sec-head");
  head.appendChild(el("span", "lsp-sec-title", t("web.sidebar.lsp_changed_title")));
  head.appendChild(el("span", "lsp-sec-note", t("web.sidebar.lsp_changed_desc")));
  box.appendChild(head);

  const btn = el("button", "lsp-file-go") as HTMLButtonElement;
  btn.type = "button";
  btn.disabled = busy;
  btn.appendChild(icon("refresh"));
  btn.appendChild(
    document.createTextNode(
      busy ? t("web.sidebar.lsp_changed_busy") : t("web.sidebar.lsp_changed_run"),
    ),
  );
  btn.addEventListener("click", () => void runChanged());
  box.appendChild(btn);
  if (busy) return;
  if (result) renderChangedResult(box, result);
}

/** Запустить пакетную проверку изменённых файлов. */
export async function runChanged(): Promise<void> {
  if (busy || !sb.lspEl) return;
  busy = true;
  renderLspChanged(sb.lspEl);
  try {
    const r = await api<Dict>("/api/lsp/check-changed", { method: "POST" });
    result = (r.data as Dict) || { ok: false, error: "failed", files: [] };
  } catch {
    result = { ok: false, error: "failed", files: [] };
  } finally {
    busy = false;
  }
  if (sb.lspEl) renderLspChanged(sb.lspEl);
}
