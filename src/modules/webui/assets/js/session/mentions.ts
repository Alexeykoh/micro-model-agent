// `@` file autocomplete for the composer: type `@src/co` and pick a workspace
// path. Uses `/api/search?names=1` (path hits only, contents are not read), then
// inserts `@path ` into the draft. The composer paints those tokens with an
// inline highlight (`inp-mark`), so a file reference no longer reads as a plain
// quoted string.
import { el, icon, inp } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import type { Dict } from "../core/store/types.js";

const list = el("div", "cmdk mention-cmdk");
list.id = "mention-list";
list.hidden = true;
list.setAttribute("role", "listbox");
const inputArea = document.querySelector(".input-area");
if (inputArea) inputArea.appendChild(list);

let items: string[] = [];
let index = 0;
let seq = 0;
let timer: number | null = null;
let autogrowFn: () => void = () => {};

/** Composer supplies autogrow; keeps this module a leaf. */
export function initMentions(deps: { autogrow?: () => void } | null): void {
  if (deps && typeof deps.autogrow === "function") autogrowFn = deps.autogrow;
}

interface Token {
  start: number;
  end: number;
  query: string;
}

/** Активный `@`-токен перед курсором (`null` — автодополнение не нужно). */
function activeToken(): Token | null {
  if (inp.selectionStart !== inp.selectionEnd) return null;
  const caret = inp.selectionStart ?? inp.value.length;
  const before = inp.value.slice(0, caret);
  const m = /(^|[\s(])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, end: caret, query: m[2] };
}

function close(): void {
  if (list.hidden) return;
  list.hidden = true;
  list.textContent = "";
  items = [];
  index = 0;
  inp.setAttribute("aria-expanded", "false");
  inp.removeAttribute("aria-activedescendant");
}

/** Перерисовать текущий `@`-запрос (вызывается на каждый `input`). */
export function updateMentions(): void {
  const token = activeToken();
  if (!token) {
    if (timer !== null) clearTimeout(timer);
    close();
    return;
  }
  if (timer !== null) clearTimeout(timer);
  const mine = ++seq;
  timer = window.setTimeout(() => void search(token.query, mine), 140);
}

async function search(query: string, mine: number): Promise<void> {
  if (!query) {
    close();
    return;
  }
  const r = await api<{ results?: Dict[] }>("/api/search?names=1&q=" + encodeURIComponent(query));
  if (mine !== seq) return;
  const current = activeToken();
  if (!current) {
    close();
    return;
  }
  const paths = (r.ok && r.data && Array.isArray(r.data.results) ? r.data.results : [])
    .filter((hit) => hit.kind === "path" && typeof hit.path === "string")
    .map((hit) => String(hit.path))
    .slice(0, 10);
  if (paths.length === 0) {
    close();
    return;
  }
  render(paths);
}

function render(paths: string[]): void {
  items = paths;
  index = 0;
  list.textContent = "";
  paths.forEach((path, i) => {
    const item = el("div", "cmdk-item" + (i === 0 ? " on" : ""));
    item.id = "mention-opt-" + i;
    item.setAttribute("role", "option");
    const ic = el("span", "mention-ic");
    ic.appendChild(icon("file"));
    item.appendChild(ic);
    item.appendChild(el("span", "mention-path", path));
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptMention(i);
    });
    list.appendChild(item);
  });
  list.hidden = false;
  list.setAttribute("aria-label", t("web.mention.label"));
  inp.setAttribute("aria-expanded", "true");
  inp.setAttribute("aria-controls", list.id);
  highlight();
}

function highlight(): void {
  Array.from(list.children).forEach((node, i) => node.classList.toggle("on", i === index));
  const on = list.children[index];
  if (on) inp.setAttribute("aria-activedescendant", on.id);
}

/** Вставить выбранный путь вместо набранного `@query`. */
export function acceptMention(i: number): void {
  const path = items[i];
  const token = activeToken();
  if (!path || !token) return;
  const insert = "@" + path + " ";
  inp.value = inp.value.slice(0, token.start) + insert + inp.value.slice(token.end);
  const caret = token.start + insert.length;
  inp.selectionStart = inp.selectionEnd = caret;
  close();
  autogrowFn();
  inp.focus();
  inp.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Keyboard navigation while the list is open; true — key consumed. */
export function mentionKeydown(e: KeyboardEvent): boolean {
  if (list.hidden) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    index = Math.min(index + 1, items.length - 1);
    highlight();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    index = Math.max(index - 1, 0);
    highlight();
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return true;
  }
  if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
    e.preventDefault();
    acceptMention(index);
    return true;
  }
  return false;
}

/** Закрыть подсказку (смена вкладки/черновика). */
export function closeMentions(): void {
  if (timer !== null) clearTimeout(timer);
  seq++;
  close();
}
