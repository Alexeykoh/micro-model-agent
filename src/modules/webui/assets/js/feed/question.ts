// Interactive `question` block in the feed (SSE `question` → `/api/answer`).
// Extracted from `feed.js`; re-exported there.
import { el, link } from "../dom.js";
import { t } from "../i18n.js";
import { api } from "../api.js";
import type { Dict } from "../core/store/types.js";
import { feedForEvent, clearEmpty, appendTo, activeFeed, scroll } from "./core.js";

interface QuestionBlock {
  block: HTMLElement;
  feed: HTMLElement;
  settle(display: unknown, raw: unknown): void;
  isAnswered(): boolean;
}

// `? ` glyph on the last line, matching the terminal menu (the tool may have
// already prefixed it — don't double it).
function questionLabel(text: unknown): string {
  const lines = String(text).split("\n");
  const last = lines[lines.length - 1];
  if (/^\s*\?/.test(last)) return String(text);
  lines[lines.length - 1] = "? " + last;
  return lines.join("\n");
}

// Answered-state + settle wiring shared by both question kinds. `display` is
// what the user sees; `raw` is exactly what goes to `/api/answer`.
function makeQuestionBlock(feed: HTMLElement, promptText: string, id: string): QuestionBlock {
  const block = el("div", "q");
  block.appendChild(el("div", "qtext", promptText));
  let answered = false;
  const settle = (display: unknown, raw: unknown): void => {
    if (answered) return;
    answered = true;
    block.classList.add("answered");
    block.textContent = "";
    block.appendChild(el("div", "qtext", promptText));
    block.appendChild(el("div", "qans", "↳ " + (String(display || "").trim() || t("web.question.answered"))));
    void api("/api/answer", { method: "POST", body: { id, value: raw } });
    if (feed === activeFeed()) scroll();
  };
  return { block, feed, settle, isAnswered: () => answered };
}

// Free-text prompt (a `text` question, or the tool's follow-up after the
// "own answer" choice — see `askUser`/`CUSTOM_INDEX`).
function questionTextInput(q: QuestionBlock, placeholder: string): HTMLElement {
  const wrap = el("div", "qcustom");
  const input = el("input", "qinput");
  input.type = "text";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const value = input.value.trim();
      if (value) q.settle(value, value);
    }
  });
  wrap.appendChild(input);
  wrap.appendChild(
    link(t("web.question.custom_send"), "", () => {
      const value = input.value.trim();
      if (value) q.settle(value, value);
    }),
  );
  if (q.feed === activeFeed()) setTimeout(() => input.focus(), 0);
  return wrap;
}

// Choice prompt: single-select settles on click, multi-select collects into a
// send button. The "own answer" entry maps to CUSTOM_INDEX (-1) so the tool
// then asks the free-text follow-up.
function questionChoice(q: QuestionBlock, data: Dict, options: unknown[]): void {
  const multiple = !!data.multiple;
  const allowCustom = !!data.allowCustom;
  const entries: Array<{ label: string; raw: number | null }> = options.map((label) => ({
    label: String(label),
    raw: null,
  }));
  if (allowCustom) entries.push({ label: t("web.question.custom"), raw: -1 });
  const rawOf = (i: number): unknown => (entries[i].raw != null ? entries[i].raw : i);
  const opts = el("div", "opts");
  const selected: number[] = [];
  let sendBtn: HTMLButtonElement | null = null;
  entries.forEach((entry, i) => {
    const row = el("button", "qopt", i + 1 + ". " + entry.label);
    row.type = "button";
    row.setAttribute("aria-checked", "false");
    row.addEventListener("click", () => {
      if (q.isAnswered()) return;
      if (multiple) {
        const pos = selected.indexOf(i);
        if (pos === -1) {
          selected.push(i);
          row.classList.add("on");
          row.setAttribute("aria-checked", "true");
        } else {
          selected.splice(pos, 1);
          row.classList.remove("on");
          row.setAttribute("aria-checked", "false");
        }
        if (sendBtn) sendBtn.disabled = selected.length === 0;
      } else {
        row.setAttribute("aria-checked", "true");
        q.settle(entry.label, [rawOf(i)]);
      }
    });
    opts.appendChild(row);
  });
  q.block.appendChild(opts);
  if (multiple) {
    q.block.appendChild(el("div", "qmulti-hint", t("web.question.multi_hint")));
    sendBtn = el("button", "qsend", t("web.question.send"));
    sendBtn.type = "button";
    sendBtn.disabled = true;
    sendBtn.addEventListener("click", () => {
      if (q.isAnswered() || !selected.length) return;
      const chosen = selected.slice().sort((a, b) => a - b);
      q.settle(chosen.map((i) => entries[i].label).join(", "), chosen.map(rawOf));
    });
    q.block.appendChild(sendBtn);
  }
}

export function onQuestion(data: Dict): void {
  if (!data || typeof data.text !== "string") return;
  const feed = feedForEvent(data.sessionId);
  if (!feed) return;
  clearEmpty(feed);
  const q = makeQuestionBlock(feed, questionLabel(data.text), data.id);
  const options = Array.isArray(data.options) ? data.options : [];
  if (data.kind === "choice" && options.length) questionChoice(q, data, options);
  else q.block.appendChild(questionTextInput(q, t("web.question.placeholder")));
  appendTo(feed, q.block);
  if (feed === activeFeed()) scroll();
}
