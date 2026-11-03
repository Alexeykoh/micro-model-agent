// Composer draft surface: textarea autogrow, the `@path` highlight mirror,
// per-tab draft/attachments save/restore, caret insertion and prompt submit.
// Split out of `composer.ts` (rule 6: ≤300 lines/file). It never sends a turn
// itself — `submitPrompt` calls the injected `submit`, so the send path stays
// in the composer.
import { inp, el } from "../dom.js";
import { tabs as tabState } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { closeCmdk, updateCmdk } from "./cmdk.js";
import { closeMentions, updateMentions } from "./mentions.js";
import { renderAttachments } from "./attachments.js";
import { renderQueueStrip } from "./queue.js";

interface ComposerDraftDeps {
  activeTab: () => Dict | null;
  submit: () => void;
}

let deps: ComposerDraftDeps = {
  activeTab: () => null,
  submit: () => {},
};

/** Composer supplies the tab owner and send action; keeps the module DAG acyclic. */
export function initComposerDraft(d: Partial<ComposerDraftDeps>): void {
  deps = { ...deps, ...d };
}

// Grow the composer with its content up to a max, then scroll.
const INPUT_MAX_PX = 200;
export function autogrow(): void {
  if (!inp) return;
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, INPUT_MAX_PX) + "px";
  renderMentionMarks();
}

// Inline highlight mirror behind the textarea: `@path` tokens become a pill,
// so a file reference reads as a mention instead of plain quoted text. The
// mirror glyphs stay transparent; only the token background shows through.
const inpMark = document.getElementById("inpMark");
const MENTION_RE = /@[^\s@]+/g;

function renderMentionMarks(): void {
  if (!inpMark) return;
  inpMark.textContent = "";
  const text = inp.value;
  let cursor = 0;
  for (let m = MENTION_RE.exec(text); m; m = MENTION_RE.exec(text)) {
    const token = m[0];
    // Только похожее на путь: `@user` не подсвечиваем.
    if (!/[./\\]/.test(token)) continue;
    if (m.index > cursor) inpMark.appendChild(document.createTextNode(text.slice(cursor, m.index)));
    inpMark.appendChild(el("span", "mmark", token));
    cursor = m.index + token.length;
  }
  if (cursor < text.length) inpMark.appendChild(document.createTextNode(text.slice(cursor)));
  inpMark.scrollTop = inp.scrollTop;
}

export function saveComposer(): void {
  const tab = deps.activeTab();
  if (!tab || !inp) return;
  tab.draft = inp.value;
  tab.attachments = tabState.attachments.slice();
}

export function restoreComposer(tab: Dict | null): void {
  if (!tab || !inp) return;
  inp.value = tab.draft || "";
  tabState.attachments = (tab.attachments || []).slice();
  renderAttachments();
  autogrow();
  closeCmdk();
  closeMentions();
  renderQueueStrip();
}

export function clearInput(): void {
  inp.value = "";
  autogrow();
  closeCmdk();
  closeMentions();
}

/**
 * Inserts `text` into the active draft at the caret (used by the Files tab to
 * attach a workspace path). Keeps the owner tab's draft and caret in sync.
 */
export function insertIntoDraft(text: string): void {
  if (!inp || !text) return;
  const start = inp.selectionStart ?? inp.value.length;
  const end = inp.selectionEnd ?? start;
  inp.value = inp.value.slice(0, start) + text + inp.value.slice(end);
  const caret = start + text.length;
  inp.selectionStart = inp.selectionEnd = caret;
  const owner = deps.activeTab();
  if (owner) owner.draft = inp.value;
  autogrow();
  updateMentions();
  inp.focus();
}

/** Отправить готовый промпт от имени пользователя (кнопка «исправить» в LSP). */
export function submitPrompt(text: string): void {
  if (!inp || !text.trim()) return;
  inp.value = text;
  const owner = deps.activeTab();
  if (owner) owner.draft = inp.value;
  autogrow();
  closeMentions();
  inp.focus();
  deps.submit();
}

if (inp)
  inp.addEventListener("input", () => {
    const owner = deps.activeTab();
    if (owner) owner.draft = inp.value;
    autogrow();
    updateCmdk();
    updateMentions();
  });
if (inp) inp.addEventListener("scroll", renderMentionMarks);
renderMentionMarks();
