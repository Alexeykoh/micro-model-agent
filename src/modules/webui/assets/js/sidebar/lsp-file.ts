// Секция «файл» вкладки LSP: диагностика файла, выбранного во вкладке «Файлы».
//
// Ручного ввода пути нет: он дублировал дерево и существовал только как
// fallback из первой редакции спеки. Файл берётся из `sb.files.selectedPath`,
// проверка запускается при открытии вкладки LSP (если файл сменился) и по
// кнопке «проверить снова». Клик по строке открывает файл во вкладке Files на
// этой строке (мост — `hooks.openFileAtLine`), чтобы не тянуть `core.js` в этот
// модуль циклическим импортом.
import { el, icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";
import { hooks } from "../store.js";
import { sb } from "./state.js";
import { fixButton } from "./lsp-fix.js";

/** Сколько диагностик показываем (сервер тоже капит, это второй предохранитель). */
const SHOW_LIMIT = 50;
/** Общий лимит авто-повторов, пока сервер стартует (60 с). */
const STARTING_MAX_MS = 60_000;

let checkedPath = "";
let lastResult: Dict | null = null;
let checking = false;
let checkStarted = 0;
let ticker: number | null = null;

/** Файл, выбранный в дереве Files (единственный источник пути). */
function selectedPath(): string {
  const p = sb.files.selectedPath;
  return typeof p === "string" ? p : "";
}

/** Секунды, которые проверка уже идёт (0 до старта). */
function checkElapsedSec(): number {
  return checking && checkStarted ? Math.max(0, Math.round((Date.now() - checkStarted) / 1000)) : 0;
}

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** Обновляет только текст прогресса, не перестраивая секцию. */
function startTicker(box: HTMLElement): void {
  stopTicker();
  const paint = () => {
    const node = box.querySelector<HTMLElement>(".lsp-file-progress");
    if (node)
      node.textContent = t("web.sidebar.lsp_file_checking", { secs: String(checkElapsedSec()) });
  };
  paint();
  ticker = window.setInterval(paint, 500);
}

function severityLabel(sev: unknown): string {
  if (sev === "error") return t("web.sidebar.lsp_sev_error");
  if (sev === "warning") return t("web.sidebar.lsp_sev_warning");
  return t("web.sidebar.lsp_sev_info");
}

function severityGlyph(sev: unknown): [string, string] {
  if (sev === "error") return ["✗", "err"];
  if (sev === "warning") return ["!", "warn"];
  return ["i", "info"];
}

/** Перерисовать секцию (без перезапроса). */
export function renderLspFile(box: HTMLElement): void {
  box.textContent = "";
  const head = el("div", "lsp-sec-head");
  head.appendChild(el("span", "lsp-sec-title", t("web.sidebar.lsp_file_title")));
  head.appendChild(el("span", "lsp-sec-note", t("web.sidebar.lsp_file_desc")));
  box.appendChild(head);

  const path = selectedPath();
  if (!path) {
    box.appendChild(el("div", "lsp-hint", t("web.sidebar.lsp_file_no_selection")));
    const open = el(
      "button",
      "lsp-file-go",
      t("web.sidebar.lsp_file_open_files"),
    ) as HTMLButtonElement;
    open.type = "button";
    open.addEventListener("click", () => hooks.showFilesTab?.());
    box.appendChild(open);
    return;
  }

  const row = el("div", "lsp-file-row");
  const name = el("span", "lsp-file-name", path);
  name.title = path;
  row.appendChild(name);

  const refresh = el("button", "lsp-file-go lsp-file-refresh") as HTMLButtonElement;
  refresh.type = "button";
  refresh.disabled = checking;
  refresh.title = t("web.sidebar.lsp_file_refresh");
  refresh.setAttribute("aria-label", `${t("web.sidebar.lsp_file_refresh")}: ${path}`);
  refresh.appendChild(icon("refresh"));
  refresh.addEventListener("click", () => void checkFile(path));
  row.appendChild(refresh);
  box.appendChild(row);

  if (checking) {
    box.appendChild(
      el(
        "div",
        "lsp-file-progress",
        t("web.sidebar.lsp_file_checking", { secs: String(checkElapsedSec()) }),
      ),
    );
    startTicker(box);
    return;
  }
  if (lastResult && String(lastResult.path || "") === path) {
    renderLspFileResult(box, lastResult);
  } else {
    box.appendChild(el("div", "lsp-hint", t("web.sidebar.lsp_file_not_checked_yet")));
  }
}

/** Результат проверки: список диагностик или «ошибок нет»/причина отказа. */
export function renderLspFileResult(box: HTMLElement, res: Dict): void {
  const path = String(res.path || "");
  const diags = Array.isArray(res.diagnostics) ? (res.diagnostics as Dict[]) : [];
  if (res.ok !== true) {
    const key = "web.sidebar.lsp_file_" + String(res.error || "failed").replace(/-/g, "_");
    const ms = Number(res.ms);
    const spent = Number.isFinite(ms) && ms > 0 ? String(Math.round(ms / 1000)) : "";
    const text = t(key, spent ? { secs: spent } : undefined);
    const hint = el("div", "lsp-file-state bad");
    hint.appendChild(el("span", "lsp-g fail", "!"));
    hint.appendChild(
      document.createTextNode(" " + (text === key ? t("web.sidebar.lsp_file_failed") : text)),
    );
    if (spent && String(res.error) !== "lsp-timeout") {
      hint.appendChild(el("span", "lsp-file-ms", formatSec(ms)));
    }
    box.appendChild(hint);
    // Причина отказа уже известна серверу: без неё «сервер не ответил»
    // одинаково описывает упавший сервер, офлайн и паузу восстановления.
    const reason = typeof res.reason === "string" ? res.reason.trim() : "";
    if (reason) box.appendChild(el("div", "lsp-file-reason", reason));
    return;
  }
  if (diags.length === 0) {
    const ok = el("div", "lsp-file-state ok");
    ok.appendChild(el("span", "lsp-g ok", "✓"));
    ok.appendChild(document.createTextNode(" " + t("web.sidebar.lsp_file_clean")));
    const ms = Number(res.ms);
    if (Number.isFinite(ms) && ms > 0) ok.appendChild(el("span", "lsp-file-ms", formatSec(ms)));
    box.appendChild(ok);
    return;
  }
  const list = el("div", "lsp-diag-list");
  diags.slice(0, SHOW_LIMIT).forEach((d) => {
    const line = Number(d.line) || 1;
    const row = el(
      "button",
      "lsp-file-diag sev-" + String(d.severity || "info"),
    ) as HTMLButtonElement;
    row.type = "button";
    row.title = t("web.sidebar.lsp_file_open_line", { path, line: String(line) });
    row.setAttribute("aria-label", row.title);
    const pos = `${line}:${Number(d.column) || 1}`;
    row.appendChild(el("span", "lsp-diag-pos", pos));
    const [glyph, cls] = severityGlyph(d.severity);
    const sev = el("span", "lsp-diag-sev " + cls, glyph);
    sev.title = severityLabel(d.severity);
    row.appendChild(sev);
    row.appendChild(el("span", "lsp-diag-msg", String(d.message || "")));
    row.addEventListener("click", () => hooks.openFileAtLine?.(path, line));
    list.appendChild(row);
  });
  box.appendChild(list);
  box.appendChild(fixButton(path, diags));
  if (diags.length > SHOW_LIMIT) {
    box.appendChild(
      el(
        "div",
        "lsp-hint",
        t("web.sidebar.lsp_file_more", { count: String(diags.length - SHOW_LIMIT) }),
      ),
    );
  }
}

function formatSec(ms: number): string {
  return t("web.sidebar.lsp_file_ms", { secs: (ms / 1000).toFixed(1) });
}

/** Проверить файл; при смене файла в «Файлах» результат заменяется. */
export async function checkFile(rawPath?: string): Promise<void> {
  const path = String(rawPath || selectedPath()).trim();
  if (!path) return;
  checkedPath = path;
  checking = true;
  checkStarted = Date.now();
  if (sb.lspEl) renderLspFileSection(sb.lspEl);
  const deadline = Date.now() + STARTING_MAX_MS;
  try {
    for (;;) {
      const r = await api<Dict>("/api/lsp/check", { method: "POST", body: { path } });
      lastResult = (r.data as Dict) || { ok: false, path, diagnostics: [], error: "failed" };
      // Большой проект грузит сервер дольше одного запроса: повторяем, пока
      // файл не сменили или не истёк общий лимит. Пользователь видит счётчик.
      if (lastResult.error !== "starting") break;
      if (checkedPath !== path || Date.now() >= deadline) break;
      const retry = Number(lastResult.retryAfterMs);
      await new Promise((resolve) => setTimeout(resolve, retry > 0 ? retry : 2000));
      if (checkedPath !== path) break;
    }
  } catch {
    lastResult = { ok: false, path, diagnostics: [], error: "failed" };
  } finally {
    checking = false;
    checkStarted = 0;
    stopTicker();
  }
  if (sb.lspEl) renderLspFileSection(sb.lspEl);
}

/**
 * Открыли вкладку LSP: если выбран другой файл, проверяем его сразу — это и
 * есть ответ на «что скажет LSP про этот файл», без ручного ввода пути.
 */
export function followFilesSelection(): void {
  if (checking) return;
  const path = selectedPath();
  if (!path) return;
  if (path === checkedPath && lastResult) return;
  void checkFile(path);
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
