// Tabs, sessions dropdown, composer and server-state loaders.
// Owns S.state hydration (loaders render their own chrome); settings imports
// loaders from here. Imports openConfirm/setIndicator from dialog (leaf).
import {
msgs, inp, tabstripEl, imgPicker, attachStrip, attachErr, sendBtn,
el, icon,
} from "./dom.js";
import { api } from "./api.js";
import { t } from "./i18n.js";
import { S, MAX_IMAGES, MAX_IMAGE_BYTES } from "./store.js";
import { relTime, contextLabel } from "./format.js";
import {
makeFeed, showEmptyFeed, activeFeed, liveFeed, appendTo,
clearEmpty, showBusy, clearFeed, finishMd, resetTurnText,
finishThink, feedHasContent, loadHistory, syncUrl, renderPlan,
scrollToBottom,
} from "./feed.js";
import { openConfirm, setIndicator } from "./dialog.js";
import { setBusy, setPlan as railSetPlan } from "./rail.js";

let sessionsErrTimer = null;

function renderTabstrip() {
  tabstripEl.textContent = "";
  S.tabs.forEach((item) => {
    const on = item.id === S.activeTabId;
    const label = item.name || item.id;
    // The id lives in the tooltip (and the sidebar copy button), not inline,
    // so the session name keeps the tab width.
    const tip = item.kind === "session" ? String(item.id) : label;
    const tab = el("div", "stab" + (on ? " on" : ""));
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", on ? "0" : "-1");
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.setAttribute("aria-label", label);
    tab.title = tip;
    const nameEl = el("span", "name", label);
    nameEl.title = tip;
    tab.appendChild(nameEl);
    const x = el("button", "stab-x");
    x.type = "button";
    x.title = t("web.topbar.close");
    x.setAttribute("aria-label", t("web.topbar.close") + ": " + label);
    x.appendChild(icon("x"));
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(item.id);
    });
    tab.appendChild(x);
    const open = () => openTab(item.id, item.name, item.kind, true);
    tab.addEventListener("click", open);
    tab.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    tabstripEl.appendChild(tab);
  });
  scrollActiveTabIntoView();
  renderSessBar();
}

// Keep the active tab visible, aligned to its START so the beginning of the
// session name stays readable (aligning the end would cut the name off,
// which is exactly what phones showed when tapping a tab on the right).
function scrollActiveTabIntoView() {
  const active = tabstripEl.querySelector(".stab.on");
  if (!active) return;
  const left = Math.max(0, active.offsetLeft - 4);
  if (left < tabstripEl.scrollLeft || left + active.offsetWidth > tabstripEl.scrollLeft + tabstripEl.clientWidth) {
    tabstripEl.scrollLeft = left;
  }
}

tabstripEl.addEventListener(
  "wheel",
  (e) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    tabstripEl.scrollLeft += e.deltaY;
  },
  { passive: false }
);

// Mirror the active session into `?session=` so a page refresh restores it.
// Only the active tab is persisted; the token param is preserved as-is.

export function updateTabName(id, name) {
  if (!id || !name) return;
  const tab = S.tabs.find((x) => x.id === id);
  if (tab && tab.name !== name) {
    tab.name = name;
    renderTabstrip();
  }
  // Patch the session list too, otherwise the dropdown keeps the stale name
  // until the next `loadSessions()` poll (15s).
  const sess = S.state.sessions.find((s) => s.id === id);
  if (sess && sess.name !== name) {
    sess.name = name;
    renderSessionsDropdown();
  }
}

export function openTab(id, name, kind, server) {
  let tab = S.tabs.find((x) => x.id === id);
  if (!tab) {
    tab = {
      id,
      name: name || id,
      kind: kind || "session",
      feed: makeFeed(),
      historyLoaded: false,
      historyLoading: false,
      planCard: null,
    };
    S.tabs.push(tab);
  } else if (name) {
    tab.name = name;
  }
  S.activeTabId = id;
  S.liveTabId = id;
  msgs.replaceChildren(tab.feed);
  renderTabstrip();
  renderSessionsDropdown();
  scrollToBottom();
  if (tab.kind === "session" && !server) {
    // Auto-opened live session: SSE fills the feed, no transcript fetch.
    tab.historyLoaded = true;
  }
  if (server && tab.kind === "session") {
    // A tab auto-opened as "live" (server=false) sets historyLoaded=true; when
    // it is opened from the server afterward we must actually fetch the
    // transcript, or a reload of the active session shows an empty feed.
    if (!feedHasContent(tab.feed)) tab.historyLoaded = false;
    // План следует за сессией: сервер уже переключил трекер на activate,
    // сразу тянем свежий план в сайдбар (не ждём 2с-полла `/api/state`).
    api("/api/sessions/activate", { method: "POST", body: { id } }).then(() => {
      loadSessions();
      api("/api/state").then((r) => {
        if (!r.ok || !r.data) return;
        S.state.host = r.data.state || {};
        S.state.busy = !!r.data.busy;
        renderPlan(S.state.host.plan);
        railSetPlan(S.state.busy && r.data.state ? r.data.state.plan : null);
      });
    });
    loadHistory(tab);
  }
  syncUrl();
}

function closeTab(id) {
  const i = S.tabs.findIndex((x) => x.id === id);
  if (i === -1) return;
  S.tabs = S.tabs.filter((x) => x.id !== id);
  if (S.activeTabId === id) {
    const next = S.tabs[Math.min(i, S.tabs.length - 1)];
    if (next) {
      S.activeTabId = next.id;
      S.liveTabId = next.id;
      msgs.replaceChildren(next.feed);
      scrollToBottom();
    } else {
      S.activeTabId = null;
      S.liveTabId = null;
      showEmptyFeed();
    }
  }
  renderTabstrip();
  renderSessionsDropdown();
  syncUrl();
}

async function newChatTab() {
  const r = await api("/api/sessions", { method: "POST", body: {} });
  if (r.ok && r.data && r.data.session && r.data.session.id) {
    const meta = r.data.session;
    openTab(meta.id, meta.name || String(meta.id), "session", false);
    await loadSessions();
    // Новая сессия — без плана: сервер уже сбросил трекер, сразу чистим сайдбар.
    const st = await api("/api/state");
    if (st.ok && st.data) {
      S.state.host = st.data.state || {};
      S.state.busy = !!st.data.busy;
      renderPlan(S.state.host.plan);
      railSetPlan(S.state.busy && st.data.state ? st.data.state.plan : null);
    }
    return;
  }
  // Server-side creation failed (no manager / offline): keep a local-only tab
  // so the user is not blocked, but surface the failure.
  S.newSeq++;
  openTab("new" + S.newSeq, t("web.empty.title"), "new", false);
  setIndicator(t("web.sessions.create_failed"), true);
}

document.getElementById("newChat").addEventListener("click", newChatTab);
document.getElementById("sessNew").addEventListener("click", () => {
  newChatTab();
  setSessOpen(false);
});
document.getElementById("sessRefresh").addEventListener("click", () => {
  loadSessions();
});

export function renderSessionsDropdown() {
  const activeList = document.getElementById("sessActiveList");
  const recentList = document.getElementById("sessRecentList");
  activeList.textContent = "";
  recentList.textContent = "";
  const activeId = S.state.activeSessionId;
  const sorted = S.state.sessions.slice().sort((a, b) => {
    const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bt - at;
  });
  let activePlaced = false;
  sorted.forEach((s) => {
    const isActive = s.id === activeId;
    const row = sessionRow(s, isActive);
    if (isActive && !activePlaced) {
      activeList.appendChild(row);
      activePlaced = true;
    } else {
      recentList.appendChild(row);
    }
  });
  if (!activePlaced) {
    activeList.appendChild(el("div", "si", t("web.sessions.none_active")));
  }
  if (!recentList.childNodes.length) {
    recentList.appendChild(el("div", "si", t("web.sessions.none")));
  }
  if (S.state.sessionsError) {
    recentList.appendChild(el("div", "dd-err", S.state.sessionsError));
  }
}

function sessionRow(s, isActive) {
  const row = el("div", "si si-row" + (isActive ? " on" : ""));
  const name = s.name || String(s.id);
  const main = el("button", "dd-row-main");
  main.type = "button";
  main.setAttribute("aria-label", name);
  main.appendChild(el("span", "id", String(s.id)));
  main.appendChild(el("span", "name", name));
  main.appendChild(el("span", "meta", relTime(s.updatedAt)));
  main.addEventListener("click", () => {
    setSessOpen(false);
    openTab(s.id, name, "session", true);
  });
  row.appendChild(main);
  // The active session can't be removed server-side (409), so it has no
  // delete control at all.
  if (!isActive) {
    const del = el("button", "del-btn");
    del.type = "button";
    del.appendChild(icon("trash"));
    const label = t("web.sessions.delete");
    del.title = label;
    del.setAttribute("aria-label", label + ": " + name);
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteSession(s.id, name);
    });
    row.appendChild(del);
  }
  return row;
}

// --- session delete: confirmation dialog --------------------------------
function confirmDeleteSession(id, name) {
  openConfirm({
    title: t("web.sessions.confirm_title"),
    body: t("web.sessions.confirm_body", { name }),
    onAccept: () => deleteSession(id),
  });
}

function showSessionsError(msg) {
  S.state.sessionsError = msg;
  renderSessionsDropdown();
  if (sessionsErrTimer) clearTimeout(sessionsErrTimer);
  sessionsErrTimer = setTimeout(() => {
    S.state.sessionsError = null;
    renderSessionsDropdown();
  }, 4500);
}

async function deleteSession(id) {
  const r = await api("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
  if (!r.ok) {
    const code = r.data && typeof r.data.error === "string" ? r.data.error : "";
    showSessionsError(code === "active_session" ? t("web.sessions.active_guard") : t("web.sessions.delete_failed"));
  } else {
    S.state.sessionsError = null;
  }
  await loadSessions();
}

const sessDD = document.getElementById("sessDD");
const sessBtn = document.getElementById("sessBtn");
export function setSessOpen(open) {
  sessDD.classList.toggle("open", !!open);
  sessBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
sessBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
  setSessOpen(!sessDD.classList.contains("open"));
});

// --- mobile session sub-header -------------------------------------------
// Phones show a session control bar under the topbar: prev/next arrows step
// through the open tabs, ✕ closes the active tab, and the + / list tools
// relocate here (see placeTopTools) so the topbar keeps room for tabs.
const sessBar = document.getElementById("sessBar");
const sessNameBtn = document.getElementById("sessNameBtn");
const sessNameEl = document.getElementById("sessName");
const sessPrevBtn = document.getElementById("sessPrev");
const sessNextBtn = document.getElementById("sessNext");
const sessCloseBtn = document.getElementById("sessClose");
const sessTools = document.getElementById("sessTools");
const barTop = document.querySelector(".bar-top");
const newChatBtn = document.getElementById("newChat");
// Anchor remembering the desktop slot of the + / list controls.
const topToolsAnchor = document.createComment("top-tools");
if (barTop && newChatBtn) barTop.insertBefore(topToolsAnchor, newChatBtn);

function stepTab(dir) {
  if (S.tabs.length < 2) return;
  const i = S.tabs.findIndex((x) => x.id === S.activeTabId);
  const n = i === -1 ? 0 : (i + dir + S.tabs.length) % S.tabs.length;
  const tab = S.tabs[n];
  // Same semantics as clicking the tab in the strip.
  if (tab) openTab(tab.id, tab.name, tab.kind, true);
}

function renderSessBar() {
  if (!sessBar) return;
  const active = S.tabs.find((x) => x.id === S.activeTabId);
  const label = active ? active.name || String(active.id) : "—";
  sessNameEl.textContent = label;
  sessNameBtn.title = label;
  const has = S.tabs.length > 0;
  sessPrevBtn.disabled = S.tabs.length < 2;
  sessNextBtn.disabled = S.tabs.length < 2;
  sessCloseBtn.disabled = !has;
  sessNameBtn.disabled = !has;
}

// Nodes are relocated (not duplicated), so their listeners and the sessions
// dropdown anchoring (.dd is position:relative) survive the move.
function placeTopTools() {
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
  if (S.activeTabId) closeTab(S.activeTabId);
});
if (sessNameBtn) sessNameBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
  setSessOpen(!sessDD.classList.contains("open"));
});
if (typeof window.matchMedia === "function") {
  const narrowMq = window.matchMedia("(max-width: 760px)");
  if (typeof narrowMq.addEventListener === "function") narrowMq.addEventListener("change", placeTopTools);
  placeTopTools();
}

document.addEventListener("click", () => {
  document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
  setSessOpen(false);
  closeCmdk();
});

function setAttachError(msg) {
  if (!attachErr) return;
  attachErr.textContent = msg;
  attachErr.hidden = false;
  clearTimeout(S.attachErrTimer);
  S.attachErrTimer = setTimeout(() => {
    attachErr.hidden = true;
  }, 4000);
}

function renderAttachments() {
  if (!attachStrip) return;
  attachStrip.textContent = "";
  attachStrip.hidden = S.attachments.length === 0;
  S.attachments.forEach((src, i) => {
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
      S.attachments.splice(i, 1);
      renderAttachments();
    });
    thumb.appendChild(rm);
    attachStrip.appendChild(thumb);
  });
}

function clearAttachments() {
  S.attachments = [];
  renderAttachments();
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

async function addFiles(files) {
  let err = "";
  for (const file of files) {
    if (!file || typeof file.type !== "string" || file.type.indexOf("image/") !== 0) {
      err = t("web.attach.only_images");
      continue;
    }
    if (S.attachments.length >= MAX_IMAGES) {
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
      if (S.attachments.length >= MAX_IMAGES) {
        err = t("web.attach.too_many", { max: MAX_IMAGES });
        break;
      }
      S.attachments.push(url);
    } catch (e) {
      err = t("web.attach.read_failed");
    }
  }
  renderAttachments();
  if (err) setAttachError(err);
}

function userMessageNode(text, images) {
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
  const files = [];
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
    if (e.relatedTarget && inputArea.contains(e.relatedTarget)) return;
    inputArea.classList.remove("dragover");
  });
  inputArea.addEventListener("drop", (e) => {
    e.preventDefault();
    inputArea.classList.remove("dragover");
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(Array.from(dt.files));
  });
}

// --- slash-command autocomplete ----------------------------------------
// List comes from the server (`/api/commands`) so it stays in sync with `/help`.
const cmdk = el("div", "cmdk");
cmdk.id = "cmdk-list";
cmdk.hidden = true;
cmdk.setAttribute("role", "listbox");
if (inputArea) inputArea.appendChild(cmdk);
let webCommands = [];
let cmdkItems = [];
let cmdkIndex = 0;

export async function loadCommands() {
  const r = await api("/api/commands");
  if (r.ok && r.data && Array.isArray(r.data.commands)) webCommands = r.data.commands;
}

function slashToken() {
  const v = inp.value;
  return v.startsWith("/") && !/\s/.test(v) ? v : null;
}

function closeCmdk() {
  if (cmdk.hidden) return;
  cmdk.hidden = true;
  cmdk.textContent = "";
  cmdkItems = [];
  cmdkIndex = 0;
  inp.setAttribute("aria-expanded", "false");
  inp.removeAttribute("aria-activedescendant");
}

function highlightCmdk() {
  Array.from(cmdk.children).forEach((node, i) => node.classList.toggle("on", i === cmdkIndex));
  const on = cmdk.children[cmdkIndex];
  if (on) inp.setAttribute("aria-activedescendant", on.id);
}

function updateCmdk() {
  const token = slashToken();
  if (token === null || !webCommands.length) {
    closeCmdk();
    return;
  }
  const q = token.slice(1).toLowerCase();
  const matches = webCommands.filter((c) => String(c.name).toLowerCase().startsWith(q)).slice(0, 8);
  if (!matches.length) {
    closeCmdk();
    return;
  }
  cmdkItems = matches;
  cmdkIndex = 0;
  cmdk.textContent = "";
  matches.forEach((c, i) => {
    const item = el("div", "cmdk-item" + (i === 0 ? " on" : ""));
    item.id = "cmdk-opt-" + i;
    item.setAttribute("role", "option");
    item.appendChild(el("span", "cmd", c.usage));
    if (c.desc) item.appendChild(el("span", "desc", c.desc));
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptCmdk(i);
    });
    cmdk.appendChild(item);
  });
  cmdk.hidden = false;
  cmdk.setAttribute("aria-label", t("web.cmdk.label"));
  inp.setAttribute("aria-expanded", "true");
  inp.setAttribute("aria-controls", cmdk.id);
  highlightCmdk();
}

function acceptCmdk(i) {
  const c = cmdkItems[i];
  if (!c) return;
  inp.value = "/" + c.name + " ";
  autogrow();
  closeCmdk();
  inp.focus();
}

// Grow the composer with its content up to a max, then scroll.
const INPUT_MAX_PX = 200;
function autogrow() {
  if (!inp) return;
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, INPUT_MAX_PX) + "px";
}
function clearInput() {
  inp.value = "";
  autogrow();
  closeCmdk();
}
if (inp)
  inp.addEventListener("input", () => {
    autogrow();
    updateCmdk();
  });

async function send() {
  const text = inp.value.trim();
  const images = S.attachments.slice();
  if (!text && !images.length) return;
  const feed = liveFeed() || activeFeed();
  // No client-side busy gate: a message sent mid-turn is queued server-side
  // (`202 {queued: n}`) and runs after the current turn, in order.
  clearEmpty(feed);
  finishMd();
  resetTurnText();
  finishThink();
  if (text.startsWith("/")) {
    appendTo(feed, el("div", "u", text));
    scrollToBottom();
    clearInput();
    const name = text.slice(1).split(/\s+/)[0].toLowerCase();
    // `/clear` and `/new` never reach the server: both are pure browser-side
    // feed/tab operations (the server has no feed to clear).
    if (name === "clear") {
      clearFeed(feed);
      return;
    }
    if (name === "new") {
      newChatTab();
      return;
    }
    const r = await api("/api/command", { method: "POST", body: { line: text } });
    if (!r.ok) {
      appendTo(feed, el("div", "detail", "↳ " + t("web.misc.command_unavailable")));
    }
    return;
  }
  if (feed && feed.querySelector(".startbanner") === null && feed.querySelector(".u") === null) {
    const banner = el("div", "startbanner");
    banner.appendChild(document.createTextNode(t("web.start.label") + " "));
    banner.appendChild(el("b", "", (S.state.config && S.state.config.model) || S.state.host.model || "—"));
    const sessionPart = S.state.host.sessionId ? " · " + t("web.start.session") + " " + String(S.state.host.sessionId) : "";
    banner.appendChild(document.createTextNode(" · " + (S.state.host.provider || (S.state.config && S.state.config.provider && S.state.config.provider.active) || "—") + " · " + contextLabel() + sessionPart));
    feed.insertBefore(banner, feed.firstChild);
  }
  appendTo(feed, userMessageNode(text, images));
  scrollToBottom();
  clearInput();
  const body = { text };
  if (images.length) body.images = images;
  const r = await api("/api/message", { method: "POST", body });
  if (!r.ok) {
    const err = (r.data && r.data.error) || r.status;
    const msg = err === "queue_full" ? t("web.input.queue_full") : err;
    appendTo(feed, el("div", "warnline", "⚠ " + msg));
  } else {
    if (images.length) clearAttachments();
    if (r.data && r.data.queued) {
      appendTo(feed, el("div", "detail", "↳ " + t("web.input.queued", { n: r.data.queued })));
    } else {
      // Delay the spinner so fast first tokens never flash it: `showBusy`
      // itself skips when a stream/think block already started.
      window.setTimeout(() => showBusy(feed), 180);
    }
  }
}

async function interrupt() {
  if (!S.state.busy) return;
  await api("/api/interrupt", { method: "POST", body: {} });
}

inp.addEventListener("keydown", (e) => {
  // Ignore keys that confirm an IME composition (CJK/RU input methods):
  // sending on that Enter would submit a half-composed message.
  if (e.isComposing || e.keyCode === 229) return;
  // Slash-command autocomplete owns the arrows/Enter/Tab/Esc while open.
  if (!cmdk.hidden) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cmdkIndex = Math.min(cmdkIndex + 1, cmdkItems.length - 1);
      highlightCmdk();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      cmdkIndex = Math.max(cmdkIndex - 1, 0);
      highlightCmdk();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeCmdk();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      acceptCmdk(cmdkIndex);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const token = slashToken();
      const selected = cmdkItems[cmdkIndex];
      // Exact command typed → send; otherwise complete the highlighted one.
      if (token && selected && token.slice(1).toLowerCase() !== String(selected.name).toLowerCase()) {
        e.preventDefault();
        acceptCmdk(cmdkIndex);
        return;
      }
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === "Escape") {
    e.preventDefault();
    interrupt();
  }
});

if (sendBtn) {
  sendBtn.addEventListener("click", () => {
    if (S.state.busy) interrupt();
    else send();
  });
}

export function closeAllMenus() {
  document.querySelectorAll("[data-sel]").forEach((s) => {
    s.classList.remove("open");
    const b = s.querySelector("button");
    if (b) b.setAttribute("aria-expanded", "false");
  });
  setSessOpen(false);
}

// Reflect the busy flag on the composer so a turn in progress is visible and
// `aria-busy` is honest for assistive tech.
export function reflectBusy() {
  if (inp) inp.setAttribute("aria-busy", S.state.busy ? "true" : "false");
  const area = document.querySelector(".input-area");
  if (area) area.classList.toggle("busy", S.state.busy);
  // Send button doubles as stop while a turn is running; the Esc hint is only
  // meaningful then.
  if (sendBtn) {
    const label = S.state.busy ? t("web.input.stop") : t("web.input.send");
    sendBtn.textContent = "";
    sendBtn.appendChild(icon(S.state.busy ? "square" : "arrow-up"));
    sendBtn.classList.toggle("busy", S.state.busy);
    sendBtn.title = label;
    sendBtn.setAttribute("aria-label", label);
  }
  const escHint = document.getElementById("hintEsc");
  if (escHint) escHint.hidden = !S.state.busy;
  setBusy(S.state.busy);
}

export async function loadSessions() {
  const r = await api("/api/sessions");
  if (!r.ok || !r.data) return;
  S.state.sessions = Array.isArray(r.data.sessions) ? r.data.sessions : [];
  renderSessionsDropdown();
}
