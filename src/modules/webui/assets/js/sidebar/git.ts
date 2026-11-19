// Changes tab for `mma web`: read-only git working tree (спека git-workflow §6.4).
//
// Список — `GET /api/git/changes`, diff файла — `GET /api/git/diff` в стек
// панели (список → diff → назад), как viewer в Files. Stage/commit-действий в
// v1 нет — долг `git-actions-ui-v2`. Весь вывод (пути, diff) — только
// `textContent`, никакого innerHTML (XSS-guard).
import { api } from "../api.js";
import { el, icon } from "../dom.js";
import { t } from "../i18n.js";
import { mqNarrow } from "./state.js";
import { sidebarDrawerOpen, setSidebarDrawer } from "./drawer.js";
import type { Dict } from "../core/store/types.js";

interface GitRow {
  path: string;
  index: string;
  worktree: string;
  oldPath?: string;
}

let rows: GitRow[] = [];
let branch = "";
let loaded = false;
let failed = false;
/** Открытый diff (стек внутри панели): null — список. */
let diffView: { path: string; staged: boolean; text: string | null; note: string } | null = null;
let loadingDiff = false;

function bodyEl(): HTMLElement | null {
  return document.getElementById("gitBody");
}

const STAGED = (r: GitRow): boolean => r.index !== " " && r.index !== "?";
const UNSTAGED = (r: GitRow): boolean => r.worktree !== " " && r.index === "?";
const bothOf = (r: GitRow): boolean => r.index !== " " && r.index !== "?" && r.worktree !== " ";

/** Одна строка файла: глиф статуса + путь (текстом). */
function rowNode(r: GitRow, staged: boolean): HTMLElement {
  const glyph = staged ? r.index : r.worktree === " " ? r.index : r.worktree;
  const node = el("button", "git-row");
  node.type = "button";
  const mark = el("span", "git-st st-" + (glyph === "?" ? "q" : glyph.toLowerCase()), glyph);
  node.appendChild(mark);
  const label = el("span", "git-path", r.oldPath ? `${r.oldPath} → ${r.path}` : r.path);
  label.title = r.path;
  node.appendChild(label);
  node.addEventListener("click", () => void openDiff(r.path, staged));
  return node;
}

function section(titleKey: string, list: GitRow[], staged: boolean): HTMLElement | null {
  if (list.length === 0) return null;
  const sec = el("div", "sec git-sec");
  const body = el("div", "sec-body");
  for (const r of list) body.appendChild(rowNode(r, staged));
  sec.appendChild(body);
  const h = el("button", "sec-h");
  h.type = "button";
  h.appendChild(el("span", "arrow", "▾"));
  h.appendChild(document.createTextNode(" " + t(titleKey)));
  h.appendChild(el("span", "n", String(list.length)));
  sec.insertBefore(h, body);
  return sec;
}

function listNode(): HTMLElement {
  const wrap = el("div", "git-list");
  if (failed) wrap.appendChild(el("div", "fdim", t("web.git.error")));
  else if (!loaded) wrap.appendChild(el("div", "fdim", t("web.git.loading")));
  else if (rows.length === 0) wrap.appendChild(el("div", "fdim", t("web.git.empty")));
  else {
    const head = el("div", "git-head");
    head.appendChild(el("span", "git-branch", "⎇ " + (branch || t("web.git.detached"))));
    head.appendChild(el("span", "git-count", t("web.git.count", { count: String(rows.length) })));
    wrap.appendChild(head);
    const unstaged = rows.filter((r) => !STAGED(r) || r.index === "?");
    const staged = rows.filter((r) => STAGED(r) || bothOf(r));
    const s1 = section("web.git.unstaged", unstaged, false);
    const s2 = section("web.git.staged", staged, true);
    if (s1) wrap.appendChild(s1);
    if (s2) wrap.appendChild(s2);
  }
  return wrap;
}

function diffNode(): HTMLElement {
  const wrap = el("div", "git-diff-view");
  const head = el("div", "git-diff-head");
  const back = el("button", "linkbtn git-back");
  back.type = "button";
  back.appendChild(icon("arrow-left"));
  back.appendChild(document.createTextNode(" " + t("web.git.back")));
  back.addEventListener("click", () => {
    diffView = null;
    renderGit();
  });
  head.appendChild(back);
  const name = el("span", "git-diff-path", diffView ? diffView.path : "");
  name.title = name.textContent || "";
  head.appendChild(name);
  wrap.appendChild(head);
  const v = diffView;
  if (!v || v.text === null) {
    wrap.appendChild(el("div", "fdim", t("web.git.loading")));
    return wrap;
  }
  if (v.note) {
    wrap.appendChild(el("div", "fdim", v.note));
    return wrap;
  }
  const pre = el("pre", "git-diff-pre", v.text);
  wrap.appendChild(pre);
  return wrap;
}

export function renderGit(): void {
  const host = bodyEl();
  if (!host) return;
  host.textContent = "";
  host.appendChild(diffView ? diffNode() : listNode());
}

async function openDiff(path: string, staged: boolean): Promise<void> {
  if (loadingDiff) return;
  loadingDiff = true;
  diffView = { path, staged, text: null, note: "" };
  renderGit();
  const q = "/api/git/diff?path=" + encodeURIComponent(path) + (staged ? "&staged=1" : "");
  const r = await api<Dict>(q);
  if (!r.ok || !r.data) {
    diffView = { path, staged, text: "", note: t("web.git.error") };
  } else if (r.data.untracked === true) {
    // Untracked-файл не в diff — в v1 показываем метку, а не его содержимое.
    diffView = { path, staged, text: "", note: t("web.git.untracked") };
  } else {
    let text = typeof r.data.diff === "string" ? r.data.diff : "";
    if (r.data.truncated === true) text += "\n\n" + t("web.git.truncated");
    diffView = { path, staged, text, note: "" };
  }
  loadingDiff = false;
  renderGit();
}

async function load(): Promise<void> {
  const r = await api<Dict>("/api/git/changes");
  if (!r.ok || !r.data) {
    failed = true;
    rows = [];
  } else {
    failed = false;
    rows = Array.isArray(r.data.files) ? (r.data.files as GitRow[]) : [];
    branch = typeof r.data.branch === "string" ? r.data.branch : "";
    if (r.data.repo === false) rows = [];
  }
  loaded = true;
  renderGit();
}

/** Вкладка открылась: показать сразу кеш, затем перечитать (как у MCP). */
export function sidebarGitState(): void {
  if (!bodyEl()) return;
  renderGit();
  void load();
}

/** Рост `filesRevision`: активная вкладка перечитывает список. */
export function sidebarGitChanged(): void {
  const pane = document.getElementById("pane-git");
  if (pane && !pane.hidden && !diffView) void load();
}

/** Открыть вкладку Changes (клик по чипу `● N`): дровер на узком экране. */
export function openGitChangesTab(): void {
  const tabs = document.querySelector(".sb");
  if (!tabs) return;
  const tab = tabs.querySelector<HTMLElement>('.sb-tab[data-tab="git"]');
  if (tab) tab.click();
  if (mqNarrow() && !sidebarDrawerOpen()) setSidebarDrawer(true);
}
