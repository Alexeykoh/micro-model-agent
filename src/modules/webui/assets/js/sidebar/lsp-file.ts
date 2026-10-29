// Секция «файл» вкладки LSP: диагностика одного файла (`POST /api/lsp/check`).
//
// Вынесено из `lsp.ts` (файл на потолке 300 строк): список серверов и проверка
// файла — разные вопросы, и в одном файле они уже не помещаются.
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { sb } from "./state.js";

/** Сколько диагностик показываем (сервер тоже капит, это второй предохранитель). */
const SHOW_LIMIT = 50;

let checkedPath = "";
let lastResult: Dict | null = null;
let checking = false;

function pathInput(): string {
  const fromFiles = sb.files.selectedPath;
  return checkedPath || (typeof fromFiles === "string" ? fromFiles : "");
}

/** Перерисовать секцию (без перезапроса). */
export function renderLspFile(box: HTMLElement): void {
  box.textContent = "";
  const head = el("div", "kv");
  head.appendChild(el("span", "dim", t("web.sidebar.lsp_file_title")));
  const path = el("input", "lsp-file-path") as HTMLInputElement;
  path.type = "text";
  path.value = pathInput();
  path.placeholder = t("web.sidebar.lsp_file_placeholder");
  path.setAttribute("aria-label", t("web.sidebar.lsp_file_placeholder"));
  head.appendChild(path);
  box.appendChild(head);

  const btn = el("button", "map-reindex", checking ? t("web.sidebar.lsp_checking") : t("web.sidebar.lsp_file_check"));
  btn.type = "button";
  btn.disabled = checking;
  btn.addEventListener("click", () => void checkFile(path.value));
  box.appendChild(btn);

  if (checking) return;
  if (lastResult) renderLspFileResult(box, lastResult);
}

/** Результат проверки: список диагностик или «ошибок нет»/причина отказа. */
export function renderLspFileResult(box: HTMLElement, res: Dict): void {
  const path = String(res.path || "");
  const diags = Array.isArray(res.diagnostics) ? (res.diagnostics as Dict[]) : [];
  if (res.ok !== true) {
    const key = "web.sidebar.lsp_file_" + String(res.error || "failed").replace(/-/g, "_");
    const text = t(key);
    box.appendChild(el("div", "lsp-hint", text === key ? t("web.sidebar.lsp_file_failed") : text));
    return;
  }
  if (diags.length === 0) {
    box.appendChild(el("div", "lsp-hint", t("web.sidebar.lsp_file_clean", { path })));
    return;
  }
  diags.slice(0, SHOW_LIMIT).forEach((d) => {
    const row = el("div", "lsp-row lsp-file-diag");
    const pos = `${String(d.line)}:${String(d.column)}`;
    row.appendChild(el("span", "lsp-lang", pos));
    const st = el("span", "lsp-status");
    st.appendChild(el("span", "lsp-g " + (d.severity === "error" ? "fail" : "dim"), d.severity === "error" ? "✗" : "–"));
    st.appendChild(document.createTextNode(" " + String(d.message || "")));
    row.appendChild(st);
    box.appendChild(row);
  });
  if (diags.length > SHOW_LIMIT) {
    box.appendChild(el("div", "lsp-hint", t("web.sidebar.lsp_file_more", { count: String(diags.length - SHOW_LIMIT) })));
  }
}

/** Запросить диагностику файла и перерисовать вкладку. */
export async function checkFile(rawPath?: string): Promise<void> {
  const path = String(rawPath || pathInput()).trim();
  if (!path) return;
  checkedPath = path;
  checking = true;
  if (sb.lspEl) renderLspFileSection(sb.lspEl);
  try {
    const r = await api<Dict>("/api/lsp/check", { method: "POST", body: { path } });
    lastResult = (r.data as Dict) || { ok: false, path, diagnostics: [], error: "failed" };
  } catch {
    lastResult = { ok: false, path, diagnostics: [], error: "failed" };
  } finally {
    checking = false;
  }
  if (sb.lspEl) renderLspFileSection(sb.lspEl);
}

/** Контейнер секции внутри вкладки: заголовок + содержимое. */
function renderLspFileSection(host: HTMLElement): void {
  let box = host.querySelector(".lsp-file") as HTMLElement | null;
  if (!box) {
    box = el("div", "lsp-file");
    host.appendChild(box);
  }
  renderLspFile(box);
}

/** Публичная точка для `renderLsp`: добавить/обновить секцию «файл». */
export function appendLspFileSection(host: HTMLElement): void {
  renderLspFileSection(host);
}
