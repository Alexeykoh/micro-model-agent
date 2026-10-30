// Composer: per-tab draft/attachments, send/interrupt, busy reflection and the
// queued-message pin. Extracted from `tabs.js`. Tab operations it needs
// (activeTab, status mutation, new/close/open) arrive via `initComposer`, so it
// does not import the tab hub. The mobile session sub-header lives in
// `sess-bar.ts` (re-exported here for `tabs.ts`).
import { inp, sendBtn, el, icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { tabs as tabState, session, settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { contextLabel } from "../format.js";
import {
  clearEmpty,
  activeFeed,
  liveFeed,
  appendTo,
  scrollToBottom,
  clearFeed,
  finishMd,
  resetTurnText,
  finishThink,
  showBusy,
  userBlock,
} from "../feed.js";
import { setBusy } from "../rail.js";
import { setSessOpen } from "../core/menus.js";
import { closeCmdk, updateCmdk, cmdkKeydown, initCmdk } from "./cmdk.js";
import { closeMentions, initMentions, mentionKeydown, updateMentions } from "./mentions.js";
import { initAttachments, renderAttachments } from "./attachments.js";
export { renderAttachments };
import { renderQueueStrip, enqueuePending } from "./queue.js";
import { initSessBar } from "./sess-bar.js";
import { logClientCommand } from "./client-command-log.js";
import { draftForModel } from "./draft.js";

export { renderSessBar } from "./sess-bar.js";

interface ComposerDeps {
  activeTab: () => Dict | null;
  setTabStatus: (id: string, status: string) => void;
  newChatTab: () => void | Promise<void>;
  markTabDead: (id: string) => void;
  openTab: (id: string, name?: string, kind?: string, server?: boolean) => void;
  closeTab: (id: string) => void;
  statusTitle: (status: unknown) => string;
}

let deps: ComposerDeps = {
  activeTab: () => null,
  setTabStatus: () => {},
  newChatTab: async () => {},
  markTabDead: () => {},
  openTab: () => {},
  closeTab: () => {},
  statusTitle: () => "",
};

/** Tab hub injects its operations; keeps the module DAG acyclic. */
export function initComposer(d: Partial<ComposerDeps>): void {
  deps = { ...deps, ...d };
  initSessBar(d);
  initAttachments({ activeTab: deps.activeTab, insertPath: insertIntoDraft });
}

// Composer supplies autogrow to the autocomplete leaves (function decl hoisted).
initCmdk({ autogrow });
initMentions({ autogrow });

// Grow the composer with its content up to a max, then scroll.
const INPUT_MAX_PX = 200;
function autogrow(): void {
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

function clearInput(): void {
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
  void send();
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

async function send(): Promise<void> {
  // В модель и в ленту — исходный текст композера (контракт `draftForModel`).
  const text = draftForModel(inp.value);
  const trimmed = text.trim();
  const images = tabState.attachments.slice();
  if (!trimmed && !images.length) return;
  // Вкладок не осталось (пустой экран = «новый чат»): поднимаем свежую сессию,
  // иначе ход ушёл бы в закрытую активную сессию, а ответ не нашёл бы вкладку.
  if (!deps.activeTab() && !trimmed.startsWith("/")) {
    await deps.newChatTab();
  }
  const tab = deps.activeTab();
  // Владелец сообщения — активная сессионная вкладка; локальные `new`-табы
  // шлют без sessionId (фолбэк сервера — тогда-активная).
  const sessionId = tab && tab.kind === "session" ? tab.id : null;
  const feed = liveFeed() || activeFeed();
  // Мёртвая вкладка (сессии нет на сервере): POST даст 404 — не шлём,
  // показываем карточку с кнопкой закрытия.
  if (tab && tab.dead) {
    clearEmpty(feed);
    deps.markTabDead(tab.id);
    return;
  }
  clearEmpty(feed);
  if (trimmed.startsWith("/")) {
    // Слэш-команда — не ход: закрываем текущий потоковый блок, чтобы её вывод
    // не слился с ответом.
    finishMd(feed);
    resetTurnText(feed);
    finishThink(feed);
    appendTo(feed, userBlock(trimmed));
    scrollToBottom();
    if (tab) {
      tab.draft = "";
      tab.attachments = [];
    }
    tabState.attachments = [];
    renderAttachments();
    clearInput();
    const name = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
    // `/clear` and `/new` are browser-side feed/tab operations (the server has
    // no feed to clear). A dedicated action still tells the server, which only
    // journals it — no server-side clear/switch happens (B-35).
    if (name === "clear") {
      logClientCommand("clear", sessionId);
      clearFeed(feed);
      return;
    }
    if (name === "new") {
      logClientCommand("new", sessionId);
      deps.newChatTab();
      return;
    }
    const body: Record<string, unknown> = { line: trimmed };
    if (sessionId) body.sessionId = sessionId;
    const r = await api("/api/command", { method: "POST", body });
    if (!r.ok) {
      appendTo(feed, el("div", "detail", "↳ " + t("web.misc.command_unavailable")));
    }
    return;
  }
  if (feed && feed.querySelector(".startbanner") === null && feed.querySelector(".u") === null) {
    const banner = el("div", "startbanner");
    banner.appendChild(document.createTextNode(t("web.start.label") + " "));
    banner.appendChild(
      el("b", "", (settings.config && settings.config.model) || session.host.model || "—"),
    );
    const sessionPart = session.host.sessionId
      ? " · " + t("web.start.session") + " " + String(session.host.sessionId)
      : "";
    banner.appendChild(
      document.createTextNode(
        " · " +
          (session.host.provider ||
            (settings.config && settings.config.provider && settings.config.provider.active) ||
            "—") +
          " · " +
          contextLabel() +
          sessionPart,
      ),
    );
    feed.insertBefore(banner, feed.firstChild);
  }
  // No client-side busy gate: a message sent while THIS session's turn runs is
  // queued server-side (`202 {queued: n, sessionId}`) and runs after it. We do
  // not append it mid-stream (it landed inside the live answer and scrolled
  // away); it stays pinned in the queue strip until its turn starts.
  const ownTurnRunning = !!(
    tab &&
    tab.kind === "session" &&
    (session.runningSessionIds || []).includes(tab.id)
  );
  let postedUser: HTMLElement | null = null;
  if (!ownTurnRunning) {
    postedUser = userBlock(text, images);
    appendTo(feed, postedUser);
    scrollToBottom();
  }
  if (tab) {
    tab.draft = "";
    tab.attachments = [];
  }
  tabState.attachments = [];
  renderAttachments();
  clearInput();
  if (sessionId && !ownTurnRunning) deps.setTabStatus(sessionId, "working");
  const body: Record<string, unknown> = { text };
  if (images.length) body.images = images;
  if (sessionId) body.sessionId = sessionId;
  const r = await api<Dict>("/api/message", { method: "POST", body });
  if (!r.ok) {
    const err = (r.data && r.data.error) || r.status;
    const msg = err === "queue_full" ? t("web.input.queue_full") : err;
    // The message was withheld from the feed (own turn was running) and the
    // server did not accept it — restore the draft so the text is not lost.
    if (postedUser === null) {
      inp.value = text;
      if (images.length) tabState.attachments = images.slice();
      renderAttachments();
      autogrow();
    }
    appendTo(feed, el("div", "warnline", "⚠ " + msg));
    if (sessionId) deps.setTabStatus(sessionId, "failed");
    return;
  }
  if (r.data && r.data.noop) {
    // Пустой сабмит — сервер вернул no-op с подсказкой, хода нет.
    if (postedUser) postedUser.remove();
    if (r.data.notice) appendTo(feed, el("div", "detail", String(r.data.notice)));
    return;
  }
  if (r.data && r.data.queued) {
    // Стоит в очереди: убираем блок из ленты и держим в пине, пока его ход не
    // начнётся — тогда `drainQueuedTurn` вернёт его в правильную точку.
    if (postedUser) postedUser.remove();
    const id = typeof r.data.id === "string" ? r.data.id : "";
    enqueuePending(tab, { id, text, images });
    renderQueueStrip();
    if (sessionId) deps.setTabStatus(sessionId, "queued");
    return;
  }
  // Started immediately. If the block was withheld (the slot looked busy but
  // freed before the POST), render it now, before the stream.
  if (!postedUser) {
    finishMd(feed);
    resetTurnText(feed);
    finishThink(feed);
    appendTo(feed, userBlock(text, images));
    scrollToBottom();
  }
  // Delay the spinner so fast first tokens never flash it: `showBusy`
  // itself skips when a stream/think block already started.
  window.setTimeout(() => showBusy(feed), 180);
}

async function interrupt(): Promise<void> {
  // Per-tab семантика: Esc/стоп в idle-вкладке чужой ход не трогает —
  // сервер ответит 409 `idle`, если бежит не наша сессия.
  const tab = deps.activeTab();
  const sessionId = tab && tab.kind === "session" ? tab.id : null;
  const running = session.runningSessionIds || [];
  if (sessionId && !running.includes(sessionId)) return;
  if (!sessionId && !session.busy) return;
  await api("/api/interrupt", { method: "POST", body: sessionId ? { sessionId } : {} });
}

inp.addEventListener("keydown", (e) => {
  // Ignore keys that confirm an IME composition (CJK/RU input methods):
  // sending on that Enter would submit a half-composed message.
  if (e.isComposing || e.keyCode === 229) return;
  // Slash-command and `@`-mention autocomplete own arrows/Enter/Tab/Esc while open.
  if (cmdkKeydown(e)) return;
  if (mentionKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void send();
  } else if (e.key === "Escape") {
    e.preventDefault();
    void interrupt();
  }
});

if (sendBtn) {
  sendBtn.addEventListener("click", () => {
    // Стоп — только свой ход: чужая вкладка шлёт как обычно (встанет в очередь).
    const tab = deps.activeTab();
    const own = tab && tab.kind === "session" && session.runningSessionIds.includes(tab.id);
    if (own) void interrupt();
    else void send();
  });
}

// Reflect the busy flag on the composer so a turn in progress is visible and
// `aria-busy` is honest for assistive tech. Per-tab: стоп/ Esc — только когда
// бежит ход СВОЕЙ сессии; чужой ход композер не блокирует (send встанет
// в per-session очередь). Глобальный rail (`setBusy`) живёт своим флагом.
export function reflectBusy(): void {
  const tab = deps.activeTab();
  const running = session.runningSessionIds || [];
  const own = !!(tab && tab.kind === "session" && running.includes(tab.id));
  if (inp) inp.setAttribute("aria-busy", own ? "true" : "false");
  const area = document.querySelector(".input-area");
  if (area) area.classList.toggle("busy", own);
  // Send button doubles as stop while OWN turn is running; the Esc hint is
  // only meaningful then.
  if (sendBtn) {
    const label = own ? t("web.input.stop") : t("web.input.send");
    sendBtn.textContent = "";
    sendBtn.appendChild(icon(own ? "square" : "arrow-up"));
    sendBtn.classList.toggle("busy", own);
    sendBtn.title = label;
    sendBtn.setAttribute("aria-label", label);
  }
  const escHint = document.getElementById("hintEsc");
  if (escHint) escHint.hidden = !own;
  setBusy(session.busy);
  // Server queue counters (`state` SSE) drive the pinned strip even for
  // entries this client has no text for (another tab / reload mid-turn).
  renderQueueStrip();
}
