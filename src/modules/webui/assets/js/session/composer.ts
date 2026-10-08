// Composer: per-tab draft/attachments, send/interrupt, busy reflection and the
// mobile session sub-header. Extracted from `tabs.js`. Tab operations it needs
// (activeTab, status mutation, new/close/open) arrive via `initComposer`, so it
// does not import the tab hub.
import { inp, imgPicker, attachStrip, attachErr, sendBtn, el, icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { tabs as tabState, session, settings, MAX_IMAGES, MAX_IMAGE_BYTES } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { contextLabel } from "../format.js";
import {
  clearEmpty, activeFeed, liveFeed, appendTo, scrollToBottom, clearFeed,
  finishMd, resetTurnText, finishThink, showBusy,
} from "../feed.js";
import { setBusy } from "../rail.js";
import { setSessOpen } from "../core/menus.js";
import { openSessionsMenu } from "./sessions-menu.js";
import { closeCmdk, updateCmdk, cmdkKeydown, initCmdk } from "./cmdk.js";

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
}

// Composer supplies autogrow to the autocomplete leaf (function decl hoisted).
initCmdk({ autogrow });

// Grow the composer with its content up to a max, then scroll.
const INPUT_MAX_PX = 200;
function autogrow(): void {
  if (!inp) return;
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, INPUT_MAX_PX) + "px";
}

function setAttachError(msg: string): void {
  if (!attachErr) return;
  attachErr.textContent = msg;
  attachErr.hidden = false;
  clearTimeout(tabState.attachErrTimer);
  tabState.attachErrTimer = setTimeout(() => {
    attachErr.hidden = true;
  }, 4000);
}

export function renderAttachments(): void {
  if (!attachStrip) return;
  attachStrip.textContent = "";
  attachStrip.hidden = tabState.attachments.length === 0;
  tabState.attachments.forEach((src: string, i: number) => {
    const thumb = el("div", "thumb");
    const img = document.createElement("img");
    img.alt = "";
    img.src = src;
    thumb.appendChild(img);
    const rm = el("button", "rm");
    rm.type = "button";
    rm.title = t("web.attach.remove");
    rm.setAttribute("aria-label", t("web.attach.remove"));
    rm.appendChild(icon("x"));
    rm.addEventListener("click", () => {
      tabState.attachments.splice(i, 1);
      renderAttachments();
    });
    thumb.appendChild(rm);
    attachStrip.appendChild(thumb);
  });
  // Черновик аттачей живёт на активной вкладке (см. saveComposer/restoreComposer).
  const owner = deps.activeTab();
  if (owner) owner.attachments = tabState.attachments.slice();
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

async function addFiles(files: File[]): Promise<void> {
  let err = "";
  for (const file of files) {
    if (!file || typeof file.type !== "string" || file.type.indexOf("image/") !== 0) {
      err = t("web.attach.only_images");
      continue;
    }
    if (tabState.attachments.length >= MAX_IMAGES) {
      err = t("web.attach.too_many", { max: MAX_IMAGES });
      break;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      err = t("web.attach.too_large");
      continue;
    }
    try {
      const url = await readAsDataUrl(file);
      if (url.indexOf("data:image/") !== 0) {
        err = t("web.attach.invalid");
        continue;
      }
      if (tabState.attachments.length >= MAX_IMAGES) {
        err = t("web.attach.too_many", { max: MAX_IMAGES });
        break;
      }
      tabState.attachments.push(url);
    } catch {
      err = t("web.attach.read_failed");
    }
  }
  renderAttachments();
  if (err) setAttachError(err);
}

function userMessageNode(text: string, images: string[] | null | undefined): HTMLElement {
  const node = el("div", "u", text);
  (images || []).forEach((src) => {
    const img = document.createElement("img");
    img.className = "uimg";
    img.alt = "";
    img.src = src;
    node.appendChild(img);
  });
  return node;
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
}

// --- mobile session sub-header -------------------------------------------
// Phones show a session control bar under the topbar: prev/next arrows step
// through the open tabs, ✕ closes the active tab, and the + / list tools
// relocate here (see placeTopTools) so the topbar keeps room for tabs.
const sessBar = document.getElementById("sessBar");
const sessNameBtn = document.getElementById("sessNameBtn") as HTMLButtonElement;
const sessNameEl = document.getElementById("sessName") as HTMLElement;
const sessPrevBtn = document.getElementById("sessPrev") as HTMLButtonElement;
const sessNextBtn = document.getElementById("sessNext") as HTMLButtonElement;
const sessCloseBtn = document.getElementById("sessClose") as HTMLButtonElement;
const sessTools = document.getElementById("sessTools");
const sessDD = document.getElementById("sessDD");
const barTop = document.querySelector(".bar-top");
const newChatBtn = document.getElementById("newChat");
// Anchor remembering the desktop slot of the + / list controls.
const topToolsAnchor = document.createComment("top-tools");
if (barTop && newChatBtn) barTop.insertBefore(topToolsAnchor, newChatBtn);

function stepTab(dir: number): void {
  if (tabState.tabs.length < 2) return;
  const i = tabState.tabs.findIndex((x) => x.id === tabState.activeTabId);
  const n = i === -1 ? 0 : (i + dir + tabState.tabs.length) % tabState.tabs.length;
  const tab = tabState.tabs[n];
  // Same semantics as clicking the tab in the strip.
  if (tab) deps.openTab(tab.id, tab.name, tab.kind, true);
}

export function renderSessBar(): void {
  if (!sessBar) return;
  const active = tabState.tabs.find((x) => x.id === tabState.activeTabId);
  const label = active ? active.name || String(active.id) : "—";
  sessNameEl.textContent = label;
  sessNameBtn.title = label + (active && active.status && active.status !== "idle" ? " · " + deps.statusTitle(active.status) : "");
  const has = tabState.tabs.length > 0;
  sessPrevBtn.disabled = tabState.tabs.length < 2;
  sessNextBtn.disabled = tabState.tabs.length < 2;
  sessCloseBtn.disabled = !has;
  sessNameBtn.disabled = !has;
}

// Nodes are relocated (not duplicated), so their listeners and the sessions
// dropdown anchoring (.dd is position:relative) survive the move.
function placeTopTools(): void {
  if (!barTop || !sessTools || !newChatBtn || !sessDD) return;
  if (window.matchMedia("(max-width: 760px)").matches) {
    sessTools.append(newChatBtn, sessDD);
  } else {
    barTop.insertBefore(newChatBtn, topToolsAnchor);
    barTop.insertBefore(sessDD, topToolsAnchor);
  }
}

if (sessPrevBtn) sessPrevBtn.addEventListener("click", () => stepTab(-1));
if (sessNextBtn) sessNextBtn.addEventListener("click", () => stepTab(1));
if (sessCloseBtn) sessCloseBtn.addEventListener("click", () => {
  if (tabState.activeTabId) deps.closeTab(tabState.activeTabId);
});
if (sessNameBtn) sessNameBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  openSessionsMenu();
});
if (typeof window.matchMedia === "function") {
  const narrowMq = window.matchMedia("(max-width: 760px)");
  if (typeof narrowMq.addEventListener === "function") narrowMq.addEventListener("change", placeTopTools);
  placeTopTools();
}

// --- attachments input wiring --------------------------------------------
if (imgPicker) {
  imgPicker.addEventListener("change", () => {
    addFiles(Array.from(imgPicker.files || []));
    imgPicker.value = "";
  });
}
const attachBtn = document.getElementById("attachBtn");
if (attachBtn && imgPicker) {
  attachBtn.addEventListener("click", () => imgPicker.click());
}
inp.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files: File[] = [];
  for (const it of items) {
    if (it.kind === "file" && it.type && it.type.indexOf("image/") === 0) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

const inputArea = document.querySelector(".input-area");
if (inputArea) {
  ["dragenter", "dragover"].forEach((ev) => {
    inputArea.addEventListener(ev, (e) => {
      e.preventDefault();
      inputArea.classList.add("dragover");
    });
  });
  inputArea.addEventListener("dragleave", (e) => {
    const de = e as DragEvent;
    if (de.relatedTarget && inputArea.contains(de.relatedTarget as Node)) return;
    inputArea.classList.remove("dragover");
  });
  inputArea.addEventListener("drop", (e) => {
    e.preventDefault();
    inputArea.classList.remove("dragover");
    const dt = (e as DragEvent).dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(Array.from(dt.files));
  });
}

function clearInput(): void {
  inp.value = "";
  autogrow();
  closeCmdk();
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
  inp.focus();
}
if (inp)
  inp.addEventListener("input", () => {
    const owner = deps.activeTab();
    if (owner) owner.draft = inp.value;
    autogrow();
    updateCmdk();
  });

async function send(): Promise<void> {
  const text = inp.value.trim();
  const images = tabState.attachments.slice();
  if (!text && !images.length) return;
  // Вкладок не осталось (пустой экран = «новый чат»): поднимаем свежую сессию,
  // иначе ход ушёл бы в закрытую активную сессию, а ответ не нашёл бы вкладку.
  if (!deps.activeTab() && !text.startsWith("/")) {
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
  // No client-side busy gate: a message sent mid-turn is queued server-side
  // (per-session: `202 {queued: n, sessionId}`) and runs after the current
  // turn, in order.
  clearEmpty(feed);
  finishMd(feed);
  resetTurnText(feed);
  finishThink(feed);
  if (text.startsWith("/")) {
    appendTo(feed, el("div", "u", text));
    scrollToBottom();
    if (tab) {
      tab.draft = "";
      tab.attachments = [];
    }
    tabState.attachments = [];
    renderAttachments();
    clearInput();
    const name = text.slice(1).split(/\s+/)[0].toLowerCase();
    // `/clear` and `/new` never reach the server: both are pure browser-side
    // feed/tab operations (the server has no feed to clear).
    if (name === "clear") {
      clearFeed(feed);
      return;
    }
    if (name === "new") {
      deps.newChatTab();
      return;
    }
    const body: Record<string, unknown> = { line: text };
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
    banner.appendChild(el("b", "", (settings.config && settings.config.model) || session.host.model || "—"));
    const sessionPart = session.host.sessionId ? " · " + t("web.start.session") + " " + String(session.host.sessionId) : "";
    banner.appendChild(document.createTextNode(" · " + (session.host.provider || (settings.config && settings.config.provider && settings.config.provider.active) || "—") + " · " + contextLabel() + sessionPart));
    feed.insertBefore(banner, feed.firstChild);
  }
  appendTo(feed, userMessageNode(text, images));
  scrollToBottom();
  if (tab) {
    tab.draft = "";
    tab.attachments = [];
  }
  tabState.attachments = [];
  renderAttachments();
  clearInput();
  if (sessionId) deps.setTabStatus(sessionId, "working");
  const body: Record<string, unknown> = { text };
  if (images.length) body.images = images;
  if (sessionId) body.sessionId = sessionId;
  const r = await api<Dict>("/api/message", { method: "POST", body });
  if (!r.ok) {
    const err = (r.data && r.data.error) || r.status;
    const msg = err === "queue_full" ? t("web.input.queue_full") : err;
    appendTo(feed, el("div", "warnline", "⚠ " + msg));
    if (sessionId) deps.setTabStatus(sessionId, "failed");
  } else if (r.data && r.data.noop) {
    // Пустой сабмит — сервер вернул no-op с подсказкой, хода нет.
    if (r.data.notice) appendTo(feed, el("div", "detail", String(r.data.notice)));
  } else {
    if (r.data && r.data.queued) {
      const n = r.data.queuedForSession || r.data.queued;
      appendTo(feed, el("div", "detail", "↳ " + t("web.input.queued", { n })));
      if (sessionId) deps.setTabStatus(sessionId, "queued");
    } else {
      // Delay the spinner so fast first tokens never flash it: `showBusy`
      // itself skips when a stream/think block already started.
      window.setTimeout(() => showBusy(feed), 180);
    }
  }
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
  // Slash-command autocomplete owns the arrows/Enter/Tab/Esc while open.
  if (cmdkKeydown(e)) return;
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
}
