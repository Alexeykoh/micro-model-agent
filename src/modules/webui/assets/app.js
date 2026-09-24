(() => {
  "use strict";

  const token = new URLSearchParams(location.search).get("token") || "";
  const THEME_KEY = "mma-theme";
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

  const msgs = document.getElementById("msgs");
  const inp = document.getElementById("inp");
  const tabstripEl = document.getElementById("tabstrip");
  const planEl = document.getElementById("plan");
  const planCountEl = document.getElementById("planCount");
  const usageEl = document.getElementById("usage");
  const envEl = document.getElementById("env");
  const wsLine = document.getElementById("wsLine");
  const saveIndicator = document.getElementById("saveIndicator");
  const attachStrip = document.getElementById("attachStrip");
  const attachErr = document.getElementById("attachErr");
  const imgPicker = document.getElementById("imgPicker");
  const connStatus = document.getElementById("connStatus");
  const liveEl = document.getElementById("live");
  const sendBtn = document.getElementById("sendBtn");

  // Announce a short status line to assistive tech (turn end, warnings/errors).
  // Clearing first forces repeats to be re-announced.
  function announce(text) {
    if (!liveEl || !text) return;
    liveEl.textContent = "";
    setTimeout(() => {
      liveEl.textContent = text;
    }, 30);
  }

  const CATEGORIES = {
    recon: [
      "read_file", "list_dir", "glob", "grep", "file_info", "project_map",
      "chunk_query", "web_search", "web_fetch", "history", "recall",
      "process_list", "process_log",
    ],
    mutate: [
      "write_file", "edit_file", "create_dir", "delete_file", "move_file",
      "attach_image",
    ],
    execute: [
      "bash", "process_kill", "pipeline_run", "browser", "download_file",
      "subagent", "mcp_call",
    ],
    meta: [
      "plan", "todo", "verify", "lsp_check", "enable_tools", "set_thinking",
      "load_skill", "remember",
    ],
  };

  const FILE_TOOLS = ["read_file", "write_file", "edit_file", "list_dir", "delete_file", "move_file", "file_info"];
  // Tools whose `path` argument points at a readable file the viewer can open.
  // `list_dir` is a directory, `delete_file`/`move_file` leave the file gone.
  const OPENABLE_TOOLS = ["read_file", "write_file", "edit_file", "file_info"];
  const IMAGE_TOOLS = ["attach_image", "browser"];
  const LINK_TOOLS = ["web_fetch", "download_file"];

  const state = {
    config: null,
    registry: [],
    webToken: null,
    models: [],
    sessions: [],
    host: {},
    busy: false,
    activeSessionId: null,
    memory: undefined,
    skills: undefined,
    pluginsData: undefined,
    providers: undefined,
    providerForm: null,
    // Transient error shown inline in the sessions dropdown (visible without the modal).
    sessionsError: null,
  };

  let tabs = [];
  let activeTabId = null;
  let liveTabId = null;
  let newSeq = 0;
  let attachments = [];
  let attachErrTimer = null;

  let curText = null;
  let curTextNodes = [];
  let curMeta = null;
  let lastPlanSig = null;
  let lastUsageSig = null;
  let lastEnvSig = null;
  let runCount = 0;
  let runFails = 0;
  let busyTimer = null;
  const pendingArgs = new Map();
  const toolNodes = new Map();

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // --- Lucide icons (MIT), inlined: chrome only. Chat status glyphs (◇ ✓ ✗ ✦ ⟡ …)
  // stay textual per docs/design/ui/STYLE.md; icons replace emoji/gear chrome.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
    menu: [
      ["line", { x1: 4, y1: 6, x2: 20, y2: 6 }],
      ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
      ["line", { x1: 4, y1: 18, x2: 20, y2: 18 }],
    ],
    settings: [
      ["path", { d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" }],
      ["circle", { cx: 12, cy: 12, r: 3 }],
    ],
    image: [
      ["rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }],
      ["circle", { cx: 9, cy: 9, r: 2 }],
      ["path", { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }],
    ],
    x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
    trash: [
      ["path", { d: "M3 6h18" }],
      ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
      ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
      ["line", { x1: 10, y1: 11, x2: 10, y2: 17 }],
      ["line", { x1: 14, y1: 11, x2: 14, y2: 17 }],
    ],
    refresh: [
      ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
      ["path", { d: "M21 3v5h-5" }],
      ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
      ["path", { d: "M8 21H3v-5" }],
    ],
    "chevron-down": [["path", { d: "m6 9 6 6 6-6" }]],
    "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
    "arrow-up": [["path", { d: "M12 19V5" }], ["path", { d: "m5 12 7-7 7 7" }]],
    square: [["rect", { width: 14, height: 14, x: 5, y: 5, rx: 2 }]],
  };

  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "svg-icon" + (cls ? " " + cls : ""));
    (ICONS[name] || []).forEach(([tag, attrs]) => {
      const child = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach((k) => child.setAttribute(k, String(attrs[k])));
      svg.appendChild(child);
    });
    return svg;
  }

  // Replace a node's contents with an icon + optional label, keeping it a real
  // control. Returns the label node so callers can preserve text-only updates.
  function setIcon(button, name, label) {
    if (!button) return null;
    button.textContent = "";
    button.appendChild(icon(name));
    if (label != null) button.appendChild(el("span", "", label));
    return button;
  }

  // Text action control (`edit`, `forget`, `add`, …) as a focusable <button>.
  function link(label, cls, onClick) {
    const b = el("button", "linkbtn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  // Upgrade an existing non-button node (a span/div kept for layout) into a
  // keyboard-activatable control.
  function activate(node, fn) {
    node.setAttribute("role", "button");
    if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
    node.addEventListener("click", fn);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn(e);
      }
    });
    return node;
  }

  // Render raw memory text (`- **date** -- **pattern:** body`) as safe DOM nodes:
  // `**…**` spans become <b>, everything else stays a text node. Never uses
  // innerHTML, so untrusted/model-written content cannot inject markup.
  function inlineTextNodes(text) {
    const frag = document.createDocumentFragment();
    const raw = String(text == null ? "" : text).replace(/^-\s*/, "");
    raw.split("**").forEach((part, i) => {
      if (part === "") return;
      if (i % 2 === 1) {
        const b = document.createElement("b");
        b.textContent = part;
        frag.appendChild(b);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
    });
    return frag;
  }

  function setPath(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function getPath(obj, path) {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[p];
    }
    return cur;
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["x-mma-token"] = token;
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      return { ok: false, status: 0, data: null };
    }
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  const I18N = { locale: "en", dicts: {} };

  function t(key, params) {
    const dict = I18N.dicts[I18N.locale] || I18N.dicts.en || {};
    const en = I18N.dicts.en || {};
    let template = dict[key];
    if (template === undefined) template = en[key];
    if (template === undefined) return key;
    if (params) {
      Object.keys(params).forEach((k) => {
        template = template.split("{" + k + "}").join(String(params[k]));
      });
    }
    return template;
  }

  // Plural form for a `{count}` template: uses `baseKey_one|_few|_many`
  // (RU one/few/many; EN one/many) and falls back to `baseKey` if absent.
  function pluralCount(baseKey, n) {
    let form;
    if (I18N.locale === "ru") {
      const m10 = n % 10;
      const m100 = n % 100;
      if (m10 === 1 && m100 !== 11) form = "one";
      else if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) form = "few";
      else form = "many";
    } else {
      form = n === 1 ? "one" : "many";
    }
    const key = baseKey + "_" + form;
    const s = t(key, { count: n });
    return s === key ? t(baseKey, { count: n }) : s;
  }

  async function loadI18n() {
    const r = await api("/api/i18n");
    if (r.ok && r.data) {
      I18N.locale = r.data.locale || "en";
      I18N.dicts = r.data.dicts || {};
    }
  }

  function categoryOf(name) {
    for (const cat of Object.keys(CATEGORIES)) {
      if (CATEGORIES[cat].indexOf(name) !== -1) return cat;
    }
    return "meta";
  }

  // Friendly, localized tool label from `tool.friendly.*`; humanize unknown names.
  function labelOf(name) {
    const key = "tool.friendly." + name;
    const s = t(key);
    if (s !== key) return s;
    const human = String(name).replace(/_/g, " ");
    return human.charAt(0).toUpperCase() + human.slice(1);
  }

  function argText(args) {
    if (!args || typeof args !== "object") return "";
    const keys = ["path", "file", "dir", "command", "query", "url", "pattern", "name", "id", "text", "prompt"];
    for (const key of keys) {
      if (typeof args[key] === "string" && args[key]) return args[key];
    }
    const keys2 = Object.keys(args);
    if (!keys2.length) return "";
    const val = args[keys2[0]];
    if (typeof val === "string") return val;
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    try {
      const json = JSON.stringify(args);
      return json === "{}" ? "" : json.slice(0, 120);
    } catch (err) {
      return "";
    }
  }

  function formatMs(ms) {
    if (typeof ms !== "number" || !isFinite(ms)) return "";
    return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
  }

  function relTime(ts) {
    if (!ts) return "";
    const diff = Date.now() - new Date(ts).getTime();
    if (!isFinite(diff) || diff < 0) return "";
    const min = Math.floor(diff / 60000);
    if (min < 1) return "now";
    if (min < 60) return min + "m";
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return hrs + "h";
    const days = Math.floor(hrs / 24);
    return days + "d";
  }

  function emptyView() {
    const wrap = el("div", "empty");
    wrap.appendChild(el("span", "g", "✦"));
    wrap.appendChild(document.createTextNode(" " + t("web.empty.title")));
    wrap.appendChild(document.createElement("br"));
    wrap.appendChild(el("span", "hint", t("web.empty.hint")));
    return wrap;
  }

  function makeFeed() {
    const feed = el("div", "feed");
    feed.appendChild(emptyView());
    return feed;
  }

  function showEmptyFeed() {
    msgs.replaceChildren(emptyView());
  }

  function clearFeed(feed) {
    if (!feed) return;
    feed.replaceChildren(emptyView());
    const tab = tabs.find((x) => x.feed === feed);
    if (tab) tab.planCard = null;
    if (feed === activeFeed()) scroll();
  }

  function activeFeed() {
    const tab = tabs.find((x) => x.id === activeTabId);
    return tab ? tab.feed : null;
  }

  function liveFeed() {
    const tab = tabs.find((x) => x.id === liveTabId) || tabs.find((x) => x.id === activeTabId);
    return tab ? tab.feed : null;
  }

  // Route a server event to the tab that owns its session (item from `broadcast`
  // enrichment); fall back to the live/active tab for events without one.
  function feedForEvent(sessionId) {
    if (sessionId) {
      const tab = tabs.find((x) => x.id === sessionId);
      if (tab) return tab.feed;
    }
    return liveFeed();
  }

  function nearBottom() {
    return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
  }

  function scroll() {
    if (nearBottom()) msgs.scrollTop = msgs.scrollHeight;
  }

  function appendTo(feed, node) {
    if (!feed) return node;
    feed.appendChild(node);
    if (feed === activeFeed()) scroll();
    return node;
  }

  function append(node) {
    return appendTo(liveFeed(), node);
  }

  function clearEmpty(feed) {
    const empty = feed && feed.querySelector(".empty");
    if (empty) empty.remove();
  }

  function clearBusy(feed) {
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    feed = feed || liveFeed();
    if (!feed) return;
    const line = feed.querySelector(".busy");
    if (line) line.remove();
  }

  // Show the in-feed "thinking" line. Called immediately after a successful
  // `/api/message` POST (202) so the wait during a slow first-run
  // summarization is visible before the first `phase` event arrives; the
  // normal event flow (`onText`/`onPhase`/`onTurnEnd`) clears it.
  function showBusy(feed) {
    feed = feed || liveFeed();
    if (!feed) return;
    clearEmpty(feed);
    if (feed.querySelector(".busy")) return;
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    const line = el("div", "busy");
    line.appendChild(el("span", "spin", "✦"));
    line.appendChild(el("span", "lab", t("web.action.thinking")));
    const time = el("span", "busytime", "· 0s");
    line.appendChild(time);
    line.appendChild(el("span", "", "· " + t("web.input.esc")));
    appendTo(feed, line);
    const started = Date.now();
    busyTimer = setInterval(() => {
      if (!line.parentNode) {
        clearInterval(busyTimer);
        busyTimer = null;
        return;
      }
      time.textContent = "· " + Math.round((Date.now() - started) / 1000) + "s";
    }, 1000);
  }

  function flushRun() {
    if (runCount <= 0) return;
    const feed = liveFeed();
    const line = el("div", "grouped");
    line.appendChild(el("span", "pipe", "│"));
    const fails = runFails > 0 ? " · " + runFails + " ✗" : " ✓";
    line.appendChild(document.createTextNode(" " + pluralCount("web.action.actions", runCount) + fails));
    appendTo(feed, line);
    runCount = 0;
    runFails = 0;
  }

  function parseFences(text) {
    const lines = String(text).split("\n");
    const parts = [];
    let textBuf = [];
    let codeBuf = [];
    let inCode = false;
    const flushText = () => {
      if (textBuf.length) {
        parts.push({ type: "text", content: textBuf.join("\n") });
        textBuf = [];
      }
    };
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (!inCode) {
          flushText();
          inCode = true;
          codeBuf = [];
        } else {
          parts.push({ type: "code", content: codeBuf.join("\n") });
          inCode = false;
          codeBuf = [];
        }
        continue;
      }
      if (inCode) codeBuf.push(line);
      else textBuf.push(line);
    }
    if (inCode) parts.push({ type: "code", content: codeBuf.join("\n") });
    else flushText();
    return parts;
  }

  function renderTextSegment(feed, raw) {
    curTextNodes.forEach((n) => n.remove());
    curTextNodes = [];
    parseFences(raw).forEach((part) => {
      if (part.type === "code") {
        const code = el("div", "code");
        code.textContent = part.content;
        feed.appendChild(code);
        curTextNodes.push(code);
      } else if (part.content) {
        const ans = el("div", "ans");
        ans.textContent = part.content;
        feed.appendChild(ans);
        curTextNodes.push(ans);
      }
    });
    if (feed === activeFeed()) scroll();
  }

  function onText(chunk, sid) {
    const feed = feedForEvent(sid);
    clearBusy(feed);
    if (!feed) return;
    clearEmpty(feed);
    if (curMeta) {
      finishMeta();
    }
    if (curText == null) {
      flushRun();
      curText = "";
      curTextNodes = [];
    }
    curText += chunk;
    renderTextSegment(feed, curText);
  }

  function finishMeta() {
    if (curMeta && curMeta.startedAt) {
      const dur = curMeta.head.querySelector(".dur");
      if (dur) dur.textContent = "· " + ((Date.now() - curMeta.startedAt) / 1000).toFixed(1) + "s";
    }
    curMeta = null;
  }

  function onMeta(chunk, sid) {
    const feed = feedForEvent(sid);
    clearBusy(feed);
    if (!feed) return;
    clearEmpty(feed);
    curText = null;
    if (!curMeta) {
      flushRun();
      const wrap = el("div", "think");
      const head = el("button", "think-h");
      head.type = "button";
      head.setAttribute("aria-expanded", "false");
      head.appendChild(el("span", "g", "✦"));
      head.appendChild(el("span", "lab", t("web.action.thinking")));
      head.appendChild(el("span", "dur", ""));
      const tog = el("span", "tog");
      setIcon(tog, "chevron-right", t("web.action.show"));
      head.appendChild(tog);
      const body = el("div", "think-body hidden");
      wrap.appendChild(head);
      wrap.appendChild(body);
      appendTo(feed, wrap);
      curMeta = { wrap, head, body, startedAt: Date.now() };
    }
    curMeta.body.textContent += chunk;
    // Reasoning is collapsed by default (quiet by default); a warning or error
    // carried on the meta channel expands the block so it is never hidden.
    if ((chunk.indexOf("⚠") !== -1 || chunk.indexOf("✗") !== -1) && curMeta.body.classList.contains("hidden")) {
      curMeta.body.classList.remove("hidden");
      curMeta.head.setAttribute("aria-expanded", "true");
      const tog = curMeta.head.querySelector(".tog");
      if (tog) setIcon(tog, "chevron-down", t("web.action.hide"));
    }
    if (feed === activeFeed()) scroll();
  }

  function onPhase(phase, sid) {
    const feed = feedForEvent(sid);
    if (phase === "thinking") {
      showBusy(feed);
    } else {
      clearBusy(feed);
    }
  }

  function onToolStart(data) {
    const feed = feedForEvent(data.sessionId);
    clearBusy(feed);
    if (!feed) return;
    clearEmpty(feed);
    curText = null;
    finishMeta();
    pendingArgs.set(data.toolCallId, data.args || {});
    const line = el("div", "act " + categoryOf(data.name));
    line.appendChild(el("span", "g", "◇"));
    line.appendChild(el("span", "lab", labelOf(data.name)));
    const args = argText(data.args);
    if (args) {
      line.appendChild(el("span", "sep", "·"));
      line.appendChild(el("span", "args", args));
    }
    const status = el("span", "ok", "");
    line.appendChild(status);
    appendTo(feed, line);
    toolNodes.set(data.toolCallId, { status, line });
    runCount++;
  }

  function renderToolOutput(line, text) {
    if (typeof text !== "string" || !text) return;
    const wrap = el("div", "toolout");
    const code = el("div", "code");
    code.textContent = text;
    wrap.appendChild(code);
    const long = text.length > 600 || text.split("\n").length > 12;
    if (long) {
      wrap.classList.add("collapsed");
      const outLabel = "▸ " + pluralCount("web.tool.output", text.length);
      const more = el("span", "more", outLabel);
      more.addEventListener("click", () => {
        const collapsed = wrap.classList.toggle("collapsed");
        more.textContent = collapsed ? outLabel : "▾ " + t("web.tool.collapse");
      });
      wrap.appendChild(more);
    }
    const feed = line && line.parentNode ? null : liveFeed();
    if (line && line.parentNode) line.parentNode.insertBefore(wrap, line.nextSibling);
    else appendTo(feed, wrap);
  }

  function safeUrl(url) {
    if (typeof url !== "string" || !url) return null;
    try {
      const u = new URL(url, location.href);
      if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:") {
        return u.href;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  function openFileViewer(path) {
    const url =
      "/api/file?path=" +
      encodeURIComponent(path) +
      (token ? "&token=" + encodeURIComponent(token) : "");
    window.open(url, "_blank", "noopener");
  }

  function cardFor(name, args, sid) {
    const feed = feedForEvent(sid);
    if (!feed) return;
    if (FILE_TOOLS.indexOf(name) !== -1) {
      const path = args.path || args.file || args.dir;
      if (!path) return;
      const card = el("div", "filecard");
      const top = el("div", "fc-top");
      top.appendChild(el("span", "g", "◇"));
      const nameEl = el("span", "name", path);
      nameEl.title = path;
      top.appendChild(nameEl);
      card.appendChild(top);
      const bottom = el("div", "fc-bottom");
      bottom.appendChild(el("span", "lab", labelOf(name)));
      if (OPENABLE_TOOLS.indexOf(name) !== -1) {
        const open = el("button", "fc-open", t("web.card.open"));
        open.type = "button";
        open.addEventListener("click", () => openFileViewer(path));
        bottom.appendChild(open);
      }
      card.appendChild(bottom);
      appendTo(feed, card);
      return;
    }
    if (LINK_TOOLS.indexOf(name) !== -1 && args.url) {
      const line = el("div", "linkline");
      line.appendChild(document.createTextNode("↳ "));
      const safe = safeUrl(args.url);
      if (safe) {
        const a = el("a", "", args.url);
        a.href = safe;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        line.appendChild(a);
        try {
          const host = new URL(safe).hostname;
          if (host) line.appendChild(el("span", "dom", " · " + host));
        } catch (err) {
          /* no hostname */
        }
      } else {
        line.appendChild(el("span", "", args.url));
      }
      appendTo(feed, line);
      return;
    }
    if (IMAGE_TOOLS.indexOf(name) !== -1) {
      const card = el("div", "imgcard");
      card.appendChild(el("div", "ph", "◧ " + t("web.card.screenshot")));
      card.appendChild(el("div", "cap", name === "attach_image" ? t("web.card.attached_image") : t("web.card.browser_viewport")));
      appendTo(feed, card);
    }
  }

  function onToolEnd(data) {
    const node = toolNodes.get(data.toolCallId);
    const line = node ? node.line : null;
    if (node) {
      const dur = formatMs(data.durationMs);
      node.status.textContent = data.success ? " ✓" + (dur ? " " + dur : "") : " ✗" + (dur ? " " + dur : "");
      if (!data.success) {
        node.status.classList.add("fail");
        runFails++;
      }
    }
    toolNodes.delete(data.toolCallId);
    const args = pendingArgs.get(data.toolCallId) || {};
    pendingArgs.delete(data.toolCallId);
    if (data.success) cardFor(data.name, args, data.sessionId);
    renderToolOutput(line, data.output);
  }

  function onTurnEnd(data) {
    state.busy = false;
    const feed = feedForEvent(data.sessionId);
    clearBusy(feed);
    finishMeta();
    curText = null;
    flushRun();
    const owner = tabs.find((x) => x.id === data.sessionId);
    if (owner) owner.planCard = null;
    if (!feed) return;
    if (data.success === false) {
      if (data.interrupted) {
        appendTo(feed, el("div", "warnline", "⚠ " + t("web.turn.stopped")));
        announce(t("web.turn.stopped"));
      } else {
        appendTo(feed, el("div", "errline", "✗ " + t("web.turn.failed")));
        announce(t("web.turn.failed"));
      }
    } else {
      const parts = [];
      if (typeof data.toolCalls === "number" && data.toolCalls > 0) {
        parts.push(t("web.turn.tools", { count: data.toolCalls }));
      }
      if (typeof data.durationMs === "number") parts.push(formatMs(data.durationMs));
      if (parts.length) appendTo(feed, el("div", "metric", "⟡ " + parts.join(" · ")));
      appendTo(feed, el("div", "sysline", "— " + t("web.turn.end", { count: data.toolCalls || 0 }) + " —"));
      announce(t("web.turn.end", { count: data.toolCalls || 0 }));
    }
  }

  function onErrorEvent(data) {
    if (!data || !data.error) return;
    const feed = feedForEvent(data.sessionId);
    if (feed) appendTo(feed, el("div", "errline", "✗ " + data.error));
    announce(String(data.error));
  }

  function onCommandOutput(text, sid) {
    const feed = feedForEvent(sid) || activeFeed();
    if (!feed) return;
    clearEmpty(feed);
    String(text)
      .split("\n")
      .forEach((line) => appendTo(feed, el("div", "cmdout", line)));
  }

  // Server-forwarded `OutputBus` line (system-prompt overflow, context probe,
  // summarization). Text is already redacted server-side; render via
  // `textContent` so nothing untrusted is parsed as HTML.
  function onLog(data) {
    if (!data || typeof data.text !== "string" || !data.text) return;
    const feed = feedForEvent(data.sessionId) || activeFeed();
    if (!feed) return;
    const level = data.level;
    const cls = level === "error" ? "errline" : level === "warn" ? "warnline" : "detail";
    const glyph = level === "error" ? "✗ " : level === "warn" ? "⚠ " : "↳ ";
    const line = el("div", cls);
    line.textContent = glyph + data.text;
    appendTo(feed, line);
    if (level === "error" || level === "warn") announce(data.text);
  }

  function renderAssistantText(feed, text) {
    parseFences(String(text)).forEach((part) => {
      if (part.type === "code") {
        const code = el("div", "code");
        code.textContent = part.content;
        feed.appendChild(code);
      } else if (part.content) {
        feed.appendChild(el("div", "ans", part.content));
      }
    });
  }

  function renderThinkBlock(feed, text) {
    const wrap = el("div", "think");
    const head = el("button", "think-h");
    head.type = "button";
    head.setAttribute("aria-expanded", "false");
    head.appendChild(el("span", "g", "✦"));
    head.appendChild(el("span", "lab", t("web.action.thinking")));
    const tog = el("span", "tog");
    setIcon(tog, "chevron-right", t("web.action.show"));
    head.appendChild(tog);
    const body = el("div", "think-body hidden");
    body.textContent = text || "";
    wrap.appendChild(head);
    wrap.appendChild(body);
    feed.appendChild(wrap);
  }

  function renderHistoryAct(feed, entry, statusNodes) {
    const line = el("div", "act " + categoryOf(entry.name));
    line.appendChild(el("span", "g", "◇"));
    line.appendChild(el("span", "lab", labelOf(entry.name)));
    const args = argText(entry.args);
    if (args) {
      line.appendChild(el("span", "sep", "·"));
      line.appendChild(el("span", "args", args));
    }
    const status = el("span", "ok", "");
    line.appendChild(status);
    feed.appendChild(line);
    if (entry.toolCallId) statusNodes.set(entry.toolCallId, status);
  }

  function renderHistoryResult(feed, entry, statusNodes) {
    const dur = formatMs(entry.duration);
    const mark = (entry.success ? " ✓" : " ✗") + (dur ? " " + dur : "");
    const status = entry.toolCallId ? statusNodes.get(entry.toolCallId) : null;
    if (status) {
      status.textContent = mark;
      if (!entry.success) status.classList.add("fail");
      statusNodes.delete(entry.toolCallId);
      return;
    }
    const line = el("div", "act " + categoryOf(entry.tool));
    line.appendChild(el("span", "g", "↳"));
    line.appendChild(el("span", "lab", labelOf(entry.tool)));
    line.appendChild(el("span", "ok" + (entry.success ? "" : " fail"), mark));
    feed.appendChild(line);
  }

  function renderHistory(feed, entries) {
    const statusNodes = new Map();
    entries.forEach((entry) => {
      if (!entry || typeof entry.kind !== "string") return;
      switch (entry.kind) {
        case "user":
          feed.appendChild(el("div", "u", entry.text || ""));
          break;
        case "assistant":
          renderAssistantText(feed, entry.text || "");
          break;
        case "reasoning":
          renderThinkBlock(feed, entry.text || "");
          break;
        case "tool_call":
          renderHistoryAct(feed, entry, statusNodes);
          break;
        case "tool_result":
          renderHistoryResult(feed, entry, statusNodes);
          break;
        case "plan":
          if (entry.text) feed.appendChild(el("div", "sysline", "▸ " + entry.text));
          break;
        case "context":
          if (entry.text) feed.appendChild(el("div", "detail", "↳ " + entry.text));
          break;
        case "error":
          feed.appendChild(el("div", "errline", "✗ " + (entry.text || "")));
          break;
        case "system":
          if (entry.text) feed.appendChild(el("div", "sysline", entry.text));
          break;
      }
    });
  }

  function feedHasContent(feed) {
    return !!feed.querySelector(".u, .ans, .code, .act, .think, .errline, .sysline");
  }

  async function loadHistory(tab) {
    if (!tab || tab.historyLoaded || tab.historyLoading) return;
    tab.historyLoading = true;
    const placeholder = el("div", "detail", t("web.history.loading"));
    if (!feedHasContent(tab.feed)) {
      clearEmpty(tab.feed);
      tab.feed.appendChild(placeholder);
    }
    const r = await api("/api/sessions/" + encodeURIComponent(tab.id) + "/history");
    tab.historyLoading = false;
    placeholder.remove();
    tab.historyLoaded = true;
    if (!r.ok || !r.data || !Array.isArray(r.data.history)) {
      if (!feedHasContent(tab.feed)) tab.feed.appendChild(el("div", "detail", t("web.history.unavailable")));
      return;
    }
    // A live session already rendered its content over SSE: don't duplicate it.
    if (feedHasContent(tab.feed)) return;
    renderHistory(tab.feed, r.data.history);
    if (!r.data.history.length) tab.feed.appendChild(el("div", "detail", t("web.history.empty")));
    if (tab.feed === activeFeed()) scroll();
  }

  function renderTabstrip() {
    tabstripEl.textContent = "";
    tabs.forEach((item) => {
      const on = item.id === activeTabId;
      const label = item.name || item.id;
      const tab = el("div", "stab" + (on ? " on" : ""));
      tab.setAttribute("role", "tab");
      tab.setAttribute("tabindex", on ? "0" : "-1");
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.setAttribute("aria-label", label);
      tab.title = label;
      const nameEl = el("span", "name", label);
      nameEl.title = label;
      tab.appendChild(nameEl);
      if (item.kind === "session") tab.appendChild(el("span", "sid", String(item.id)));
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

  function openTab(id, name, kind, server) {
    let tab = tabs.find((x) => x.id === id);
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
      tabs.push(tab);
    } else if (name) {
      tab.name = name;
    }
    activeTabId = id;
    liveTabId = id;
    msgs.replaceChildren(tab.feed);
    renderTabstrip();
    renderSessionsDropdown();
    msgs.scrollTop = msgs.scrollHeight;
    if (tab.kind === "session" && !server) {
      // Auto-opened live session: SSE fills the feed, no transcript fetch.
      tab.historyLoaded = true;
    }
    if (server && tab.kind === "session") {
      api("/api/sessions/activate", { method: "POST", body: { id } }).then(() => loadSessions());
      loadHistory(tab);
    }
  }

  function closeTab(id) {
    const i = tabs.findIndex((x) => x.id === id);
    if (i === -1) return;
    tabs = tabs.filter((x) => x.id !== id);
    if (activeTabId === id) {
      const next = tabs[Math.min(i, tabs.length - 1)];
      if (next) {
        activeTabId = next.id;
        liveTabId = next.id;
        msgs.replaceChildren(next.feed);
      } else {
        activeTabId = null;
        liveTabId = null;
        showEmptyFeed();
      }
    }
    renderTabstrip();
    renderSessionsDropdown();
  }

  async function newChatTab() {
    const r = await api("/api/sessions", { method: "POST", body: {} });
    if (r.ok && r.data && r.data.session && r.data.session.id) {
      const meta = r.data.session;
      openTab(meta.id, meta.name || String(meta.id), "session", false);
      await loadSessions();
      return;
    }
    // Server-side creation failed (no manager / offline): keep a local-only tab
    // so the user is not blocked, but surface the failure.
    newSeq++;
    openTab("new" + newSeq, t("web.empty.title"), "new", false);
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

  function renderSessionsDropdown() {
    const activeList = document.getElementById("sessActiveList");
    const recentList = document.getElementById("sessRecentList");
    activeList.textContent = "";
    recentList.textContent = "";
    const activeId = state.activeSessionId;
    const sorted = state.sessions.slice().sort((a, b) => {
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
    if (state.sessionsError) {
      recentList.appendChild(el("div", "dd-err", state.sessionsError));
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
    state.sessionsError = msg;
    renderSessionsDropdown();
    if (sessionsErrTimer) clearTimeout(sessionsErrTimer);
    sessionsErrTimer = setTimeout(() => {
      state.sessionsError = null;
      renderSessionsDropdown();
    }, 4500);
  }

  async function deleteSession(id) {
    const r = await api("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.ok) {
      const code = r.data && typeof r.data.error === "string" ? r.data.error : "";
      showSessionsError(code === "active_session" ? t("web.sessions.active_guard") : t("web.sessions.delete_failed"));
    } else {
      state.sessionsError = null;
    }
    await loadSessions();
  }

  const sessDD = document.getElementById("sessDD");
  const sessBtn = document.getElementById("sessBtn");
  function setSessOpen(open) {
    sessDD.classList.toggle("open", !!open);
    sessBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  sessBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
    setSessOpen(!sessDD.classList.contains("open"));
  });

  document.addEventListener("click", () => {
    document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
    setSessOpen(false);
    closeCmdk();
  });

  msgs.addEventListener("click", (e) => {
    const head = e.target.closest(".think-h");
    if (!head) return;
    const body = head.nextElementSibling;
    if (!body) return;
    const hidden = body.classList.toggle("hidden");
    head.setAttribute("aria-expanded", hidden ? "false" : "true");
    const tog = head.querySelector(".tog");
    if (tog) setIcon(tog, hidden ? "chevron-right" : "chevron-down", t(hidden ? "web.action.show" : "web.action.hide"));
  });

  function setAttachError(msg) {
    if (!attachErr) return;
    attachErr.textContent = msg;
    attachErr.hidden = false;
    clearTimeout(attachErrTimer);
    attachErrTimer = setTimeout(() => {
      attachErr.hidden = true;
    }, 4000);
  }

  function renderAttachments() {
    if (!attachStrip) return;
    attachStrip.textContent = "";
    attachStrip.hidden = attachments.length === 0;
    attachments.forEach((src, i) => {
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
        attachments.splice(i, 1);
        renderAttachments();
      });
      thumb.appendChild(rm);
      attachStrip.appendChild(thumb);
    });
  }

  function clearAttachments() {
    attachments = [];
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
      if (attachments.length >= MAX_IMAGES) {
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
        if (attachments.length >= MAX_IMAGES) {
          err = t("web.attach.too_many", { max: MAX_IMAGES });
          break;
        }
        attachments.push(url);
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

  async function loadCommands() {
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
    const images = attachments.slice();
    if (!text && !images.length) return;
    const feed = liveFeed() || activeFeed();
    if (state.busy) {
      // Don't drop the input silently: tell the user a turn is still running.
      if (feed) appendTo(feed, el("div", "warnline", "⚠ " + t("web.input.busy")));
      return;
    }
    clearEmpty(feed);
    curText = null;
    finishMeta();
    if (text.startsWith("/")) {
      appendTo(feed, el("div", "u", text));
      clearInput();
      const name = text.slice(1).split(/\s+/)[0].toLowerCase();
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
      banner.appendChild(el("b", "", (state.config && state.config.model) || state.host.model || "—"));
      const sessionPart = state.host.sessionId ? " · " + t("web.start.session") + " " + String(state.host.sessionId) : "";
      banner.appendChild(document.createTextNode(" · " + (state.host.provider || (state.config && state.config.provider && state.config.provider.active) || "—") + " · " + contextLabel() + sessionPart));
      feed.insertBefore(banner, feed.firstChild);
    }
    appendTo(feed, userMessageNode(text, images));
    clearInput();
    const body = { text };
    if (images.length) body.images = images;
    const r = await api("/api/message", { method: "POST", body });
    if (!r.ok) {
      const msg = (r.data && r.data.error) || r.status;
      appendTo(feed, el("div", "warnline", "⚠ " + msg));
    } else {
      if (images.length) clearAttachments();
      showBusy(feed);
    }
  }

  async function interrupt() {
    if (!state.busy) return;
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
      if (state.busy) interrupt();
      else send();
    });
  }

  document.querySelectorAll("[data-collapse]").forEach((head) => {
    const initArrow = head.querySelector(".arrow");
    if (initArrow) {
      initArrow.textContent = "";
      initArrow.appendChild(icon("chevron-down"));
    }
    head.addEventListener("click", () => {
      const body = head.nextElementSibling;
      if (!body) return;
      const collapsed = body.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const arrow = head.querySelector(".arrow");
      if (arrow) {
        arrow.textContent = "";
        arrow.appendChild(icon(collapsed ? "chevron-right" : "chevron-down"));
      }
    });
  });

  function contextLabel() {
    const n = (state.config && state.config.contextWindow) || 0;
    return n ? Math.round(n / 1024) + "K" : "—";
  }

  function setSelButton(btn, label, value) {
    btn.textContent = label + ":";
    btn.appendChild(el("b", "", value));
    btn.appendChild(icon("chevron-down"));
  }

  function closeAllMenus() {
    document.querySelectorAll("[data-sel]").forEach((s) => {
      s.classList.remove("open");
      const b = s.querySelector("button");
      if (b) b.setAttribute("aria-expanded", "false");
    });
    setSessOpen(false);
  }

  function menuItem(label, sub, active, onClick) {
    const mi = el("button", "mi" + (active ? " on" : ""));
    mi.type = "button";
    mi.setAttribute("aria-pressed", active ? "true" : "false");
    mi.appendChild(el("span", "", label));
    if (sub) mi.appendChild(el("span", "sub", sub));
    mi.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      closeAllMenus();
    });
    return mi;
  }

  // Menu action row (refresh, custom, add…) with an optional leading icon.
  function menuAction(label, iconName, onClick) {
    const mi = el("button", "mi row-mi");
    mi.type = "button";
    if (iconName) mi.appendChild(icon(iconName));
    mi.appendChild(el("span", "", label));
    mi.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllMenus();
      onClick();
    });
    return mi;
  }

  function renderSelectors() {
    const cfg = state.config || {};
    const provider = cfg.provider || {};

    setSelButton(document.getElementById("selModelBtn"), t("web.selectors.model"), cfg.model || "—");
    const modelMenu = document.getElementById("selModelMenu");
    modelMenu.textContent = "";
    if (!state.models.length) {
      modelMenu.appendChild(el("div", "mi dim", t("web.selectors.no_models")));
    } else {
      state.models.forEach((m) => {
        modelMenu.appendChild(menuItem(m, "", m === cfg.model, () => postConfig("model", m, true)));
      });
    }
    modelMenu.appendChild(el("div", "sep"));
    modelMenu.appendChild(
      menuAction(t("web.selectors.refresh_list"), "refresh", () => {
        loadModels().then(renderSelectors);
      }),
    );

    setSelButton(document.getElementById("selProviderBtn"), t("web.selectors.provider"), provider.active || provider.type || "—");
    const provMenu = document.getElementById("selProviderMenu");
    provMenu.textContent = "";
    const entries = Array.isArray(provider.entries) && provider.entries.length
      ? provider.entries
      : [{ label: provider.active || provider.type, type: provider.type }];
    entries.forEach((entry) => {
      const name = entry.label || entry.type;
      if (!name) return;
      provMenu.appendChild(menuItem(name, entry.type || "", name === (provider.active || provider.type), () => postConfig("provider.active", name, true)));
    });

    setSelButton(document.getElementById("selContextBtn"), t("web.selectors.context"), contextLabel());
    const ctxMenu = document.getElementById("selContextMenu");
    ctxMenu.textContent = "";
    const sizes = [8192, 16384, 32768, 65536, 131072];
    sizes.forEach((n) => {
      ctxMenu.appendChild(menuItem(Math.round(n / 1024) + "K", n === cfg.contextWindow ? t("web.selectors.current") : "", n === cfg.contextWindow, () => postConfig("contextWindow", n, false)));
    });
    ctxMenu.appendChild(el("div", "sep"));
    // Inline custom size (no native `window.prompt`): the menu stays open while
    // typing; Enter/save commits and closes it.
    const custom = el("button", "mi row-mi");
    custom.type = "button";
    custom.appendChild(icon("settings"));
    custom.appendChild(el("span", "", t("web.selectors.custom")));
    custom.addEventListener("click", (e) => {
      e.stopPropagation();
      if (ctxMenu.querySelector(".ctx-custom")) return;
      const wrap = el("div", "ctx-custom");
      const input = el("input");
      input.type = "number";
      input.min = "1024";
      input.step = "1024";
      input.value = String(cfg.contextWindow || 32768);
      input.placeholder = t("web.selectors.context_prompt");
      input.setAttribute("aria-label", t("web.selectors.context_prompt"));
      const commit = () => {
        const n = Number(input.value.trim());
        if (Number.isFinite(n) && n >= 1024) {
          closeAllMenus();
          postConfig("contextWindow", n, false);
        } else {
          input.focus();
        }
      };
      input.addEventListener("click", (ev) => ev.stopPropagation());
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") {
          ev.preventDefault();
          commit();
        } else if (ev.key === "Escape") {
          wrap.remove();
        }
      });
      const ok = link(t("web.settings.save"), "", commit);
      wrap.appendChild(input);
      wrap.appendChild(ok);
      ctxMenu.appendChild(wrap);
      setTimeout(() => input.focus(), 0);
    });
    ctxMenu.appendChild(custom);
  }

  document.querySelectorAll("[data-sel]").forEach((sel) => {
    const btn = sel.querySelector("button");
    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setSessOpen(false);
      document.querySelectorAll("[data-sel]").forEach((s) => {
        if (s !== sel) {
          s.classList.remove("open");
          const b = s.querySelector("button");
          if (b) b.setAttribute("aria-expanded", "false");
        }
      });
      const open = sel.classList.toggle("open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  let sessionsErrTimer = null;
  let indicatorTimer = null;
  function setIndicator(msg, fail) {
    if (!saveIndicator) return;
    saveIndicator.textContent = msg;
    saveIndicator.classList.toggle("fail", !!fail);
    saveIndicator.classList.add("show");
    clearTimeout(indicatorTimer);
    indicatorTimer = setTimeout(() => saveIndicator.classList.remove("show"), 2400);
  }

  async function postConfig(key, value, refreshSettings) {
    const r = await api("/api/config", { method: "POST", body: { key, value } });
    if (r.ok && r.data && r.data.ok) {
      const persisted = r.data.persisted !== false;
      setIndicator(persisted ? t("web.settings.saved") : (r.data.warning || "not persisted"), !persisted);
      if (state.config && r.data.value !== undefined) setPath(state.config, key, r.data.value);
      if (key === "locale") {
        await loadI18n();
        applyStaticI18n();
        renderSettings();
      }
      renderSelectors();
      if (refreshSettings) renderSettings();
      return true;
    }
    const err = (r.data && (r.data.error || r.data.reason)) || r.status || t("web.settings.save_failed");
    setIndicator(String(err), true);
    return false;
  }

  // Reflect the busy flag on the composer so a turn in progress is visible and
  // `aria-busy` is honest for assistive tech.
  function reflectBusy() {
    if (inp) inp.setAttribute("aria-busy", state.busy ? "true" : "false");
    const area = document.querySelector(".input-area");
    if (area) area.classList.toggle("busy", state.busy);
    // Send button doubles as stop while a turn is running; the Esc hint is only
    // meaningful then.
    if (sendBtn) {
      const label = state.busy ? t("web.input.stop") : t("web.input.send");
      sendBtn.textContent = "";
      sendBtn.appendChild(icon(state.busy ? "square" : "arrow-up"));
      sendBtn.classList.toggle("busy", state.busy);
      sendBtn.title = label;
      sendBtn.setAttribute("aria-label", label);
    }
    const escHint = document.getElementById("hintEsc");
    if (escHint) escHint.hidden = !state.busy;
  }

  function renderState(snapshot, busy) {
    state.host = snapshot || {};
    state.busy = !!busy;
    reflectBusy();
    const sessionId = state.host.sessionId || null;
    state.activeSessionId = sessionId;
    if (sessionId && !tabs.some((x) => x.id === sessionId)) {
      openTab(sessionId, state.host.sessionName || String(sessionId), "session", false);
    }
    if (!tabs.length) showEmptyFeed();
    renderPlan(state.host.plan);
    renderUsage(state.host);
    renderEnvironment(state.host);
    renderWorkspace(state.host);
    renderSessionsDropdown();
  }

  function renderPlan(plan) {
    // The sidebar polls `/api/state` every 2s; skip a rebuild (and the scroll
    // reset it would cause) when the snapshot is unchanged.
    const sig = JSON.stringify([plan, I18N.locale]);
    if (sig === lastPlanSig) return;
    lastPlanSig = sig;
    planEl.textContent = "";
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
      planCountEl.textContent = "";
      planEl.appendChild(el("div", "kv dim", t("web.plan.none")));
      return;
    }
    const done = plan.steps.filter((s) => s.status === "done").length;
    const total = plan.steps.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    planCountEl.textContent = done + " / " + total;
    const bar = el("div", "plan-bar");
    const track = el("span", "pbar");
    const fill = el("i");
    fill.style.width = pct + "%";
    track.appendChild(fill);
    bar.appendChild(track);
    bar.appendChild(el("span", "", pct + "%"));
    planEl.appendChild(bar);
    plan.steps.forEach((step, i) => {
      const current = i === plan.currentIndex && step.status !== "done" && step.status !== "failed";
      const status = step.status === "done" ? "done" : step.status === "failed" ? "fail" : current ? "cur" : "";
      const glyph = step.status === "done" ? "✓ " : step.status === "failed" ? "✗ " : current ? "▸ " : "○ ";
      planEl.appendChild(el("div", ("plan-step " + status).trim(), glyph + step.text));
    });
  }

  function onPlan(data) {
    const feed = feedForEvent(data && data.sessionId);
    if (!feed || !data || !Array.isArray(data.steps) || !data.steps.length) return;
    clearEmpty(feed);
    const tab = tabs.find((x) => x.feed === feed);
    let card = tab ? tab.planCard : null;
    if (!card || card.parentNode !== feed) {
      card = el("div", "planblock");
      appendTo(feed, card);
      if (tab) tab.planCard = card;
    }
    card.textContent = "";
    const total = data.steps.length;
    const cur = typeof data.currentIndex === "number" ? data.currentIndex : -1;
    card.appendChild(el("div", "ph2", "◇ " + pluralCount("web.plan.heading", total)));
    data.steps.forEach((step, i) => {
      const status =
        step.status === "done" ? "done" : step.status === "failed" ? "fail" : i === cur ? "cur" : "";
      const glyph =
        step.status === "done" ? "✓ " : step.status === "failed" ? "✗ " : i === cur ? "▸ " : "○ ";
      card.appendChild(el("div", ("st " + status).trim(), glyph + step.text));
    });
    if (feed === activeFeed()) scroll();
  }

  // `? ` glyph on the last line, matching the terminal menu (the tool may have
  // already prefixed it — don't double it).
  function questionLabel(text) {
    const lines = String(text).split("\n");
    const last = lines[lines.length - 1];
    if (/^\s*\?/.test(last)) return String(text);
    lines[lines.length - 1] = "? " + last;
    return lines.join("\n");
  }

  function onQuestion(data) {
    if (!data || typeof data.text !== "string") return;
    const feed = feedForEvent(data.sessionId);
    if (!feed) return;
    clearEmpty(feed);
    const promptText = questionLabel(data.text);
    const block = el("div", "q");
    block.appendChild(el("div", "qtext", promptText));
    let answered = false;

    // `display` is what the user sees; `raw` is exactly what goes to `/api/answer`.
    const settle = (display, raw) => {
      if (answered) return;
      answered = true;
      block.classList.add("answered");
      block.textContent = "";
      block.appendChild(el("div", "qtext", promptText));
      block.appendChild(el("div", "qans", "↳ " + (String(display || "").trim() || t("web.question.answered"))));
      api("/api/answer", { method: "POST", body: { id: data.id, value: raw } });
      if (feed === activeFeed()) scroll();
    };

    // Free-text prompt (a `text` question, or the tool's follow-up after the
    // "own answer" choice — see `askUser`/`CUSTOM_INDEX`).
    const textInput = (placeholder) => {
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
          if (value) settle(value, value);
        }
      });
      wrap.appendChild(input);
      wrap.appendChild(
        link(t("web.question.custom_send"), "", () => {
          const value = input.value.trim();
          if (value) settle(value, value);
        }),
      );
      if (feed === activeFeed()) setTimeout(() => input.focus(), 0);
      return wrap;
    };

    const options = Array.isArray(data.options) ? data.options : [];
    if (data.kind === "choice" && options.length) {
      const multiple = !!data.multiple;
      const allowCustom = !!data.allowCustom;
      // UI entries; the "own answer" entry maps to CUSTOM_INDEX (-1) so the tool
      // then asks the free-text follow-up.
      const entries = options.map((label) => ({ label, raw: null }));
      if (allowCustom) entries.push({ label: t("web.question.custom"), raw: -1 });
      const rawOf = (i) => (entries[i].raw != null ? entries[i].raw : i);
      const opts = el("div", "opts");
      const selected = [];
      let sendBtn = null;
      entries.forEach((entry, i) => {
        const row = el("button", "qopt", i + 1 + ". " + entry.label);
        row.type = "button";
        row.setAttribute("aria-checked", "false");
        row.addEventListener("click", () => {
          if (answered) return;
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
            settle(entry.label, [rawOf(i)]);
          }
        });
        opts.appendChild(row);
      });
      block.appendChild(opts);
      if (multiple) {
        block.appendChild(el("div", "qmulti-hint", t("web.question.multi_hint")));
        sendBtn = el("button", "qsend", t("web.question.send"));
        sendBtn.type = "button";
        sendBtn.disabled = true;
        sendBtn.addEventListener("click", () => {
          if (answered || !selected.length) return;
          const chosen = selected.slice().sort((a, b) => a - b);
          settle(chosen.map((i) => entries[i].label).join(", "), chosen.map(rawOf));
        });
        block.appendChild(sendBtn);
      }
    } else {
      block.appendChild(textInput(t("web.question.placeholder")));
    }
    appendTo(feed, block);
    if (feed === activeFeed()) scroll();
  }

  function usageRow(label, value, cls) {
    const row = el("div", "kv");
    row.appendChild(el("span", "", label));
    row.appendChild(el("b", cls || "", value));
    return row;
  }

  function renderUsage(h) {
    const cfg = state.config || {};
    const sig = JSON.stringify([
      h.sessionId, h.model, h.contextUsed, h.contextLimit, h.cacheHitRate, h.costUsd,
      h.compactionCount, h.contextQuality, h.contextProbe, cfg.model, cfg.contextWindow,
      I18N.locale,
    ]);
    if (sig === lastUsageSig) return;
    lastUsageSig = sig;
    usageEl.textContent = "";
    const sid = h.sessionId ? String(h.sessionId) : "—";
    usageEl.appendChild(usageRow(t("web.usage.session"), sid));
    usageEl.appendChild(usageRow(t("web.usage.model"), h.model || cfg.model || "—"));
    const used = typeof h.contextUsed === "number" ? h.contextUsed : null;
    const limit = typeof h.contextLimit === "number" ? h.contextLimit : cfg.contextWindow || null;
    usageEl.appendChild(usageRow(t("web.usage.context"), used != null && limit ? fmtTokens(used) + " / " + fmtTokens(limit) : "—"));
    if (used != null && limit) {
      const bar = el("div", "bar");
      const fill = el("i");
      fill.style.width = Math.min(100, Math.round((used / limit) * 100)) + "%";
      bar.appendChild(fill);
      usageEl.appendChild(bar);
    }
    const hit = typeof h.cacheHitRate === "number" ? h.cacheHitRate : null;
    usageEl.appendChild(usageRow(t("web.usage.cache"), hit != null ? Math.round(hit * 100) + "%" : "—", hit != null ? "" : "dim"));
    usageEl.appendChild(usageRow(t("web.usage.cost"), typeof h.costUsd === "number" ? "$" + h.costUsd.toFixed(4) : "—"));
    usageEl.appendChild(usageRow(t("web.usage.compactions"), "⟳ " + (h.compactionCount || 0), h.compactionCount ? "wn" : "dim"));
    const q = typeof h.contextQuality === "number" ? h.contextQuality : null;
    usageEl.appendChild(usageRow(t("web.usage.quality"), q != null ? Math.round(q) + "%" : "—", q != null ? "" : "dim"));

    // Context probe: real LM Studio loaded context vs configured. Pending/absent
    // renders a dim dash; loaded < configured warns.
    let probeText = "—";
    let probeCls = "dim";
    const probe = h.contextProbe;
    if (probe && typeof probe.actual === "number") {
      const actual = fmtTokens(probe.actual);
      const configured = h.contextLimit || cfg.contextWindow || null;
      if (configured && probe.actual < configured) {
        probeText = t("web.usage.probe_low", { actual, configured: fmtTokens(configured) });
        probeCls = "wn";
      } else {
        probeText = t("web.usage.probe_loaded", { actual });
        probeCls = "";
      }
    }
    usageEl.appendChild(usageRow(t("web.usage.probe"), probeText, probeCls));
  }

  // Workspace path under the composer (dim, own line).
  function renderWorkspace(h) {
    const ws = h.workspace || "";
    if (wsLine.dataset.ws === ws) return;
    wsLine.dataset.ws = ws;
    wsLine.textContent = "";
    wsLine.hidden = !ws;
    if (!ws) return;
    wsLine.appendChild(el("span", "ws-k", t("web.env.dir")));
    const v = el("span", "ws-v", ws);
    v.title = ws;
    wsLine.appendChild(v);
  }

  // Environment (sidebar): stacked name/value items — AGENTS.md sources, map size.
  function envItem(label, values) {
    const item = el("div", "env-item");
    item.appendChild(el("div", "env-k", label));
    values.forEach((val) => {
      const v = el("div", "env-v", val);
      v.title = val;
      item.appendChild(v);
    });
    return item;
  }

  function renderEnvironment(h) {
    const disabled = !!(h.instructions && h.instructions.disabled);
    const files = h.instructions && !disabled ? h.instructions.files || [] : [];
    const map = h.projectMap || null;
    const sig = JSON.stringify([disabled, files, map, I18N.locale]);
    if (sig === lastEnvSig) return;
    lastEnvSig = sig;
    envEl.textContent = "";
    envEl.appendChild(
      envItem(
        t("web.env.agents"),
        disabled ? [t("web.env.agents_disabled")] : files.length ? files : [t("web.env.agents_none")],
      ),
    );
    envEl.appendChild(
      envItem(
        t("web.env.map"),
        map && map.indexed
          ? [
              [
                pluralCount("web.env.files", map.files),
                pluralCount("web.env.symbols", map.symbols),
                pluralCount("web.env.tokens", map.tokens),
              ].join(" · "),
            ]
          : [t("web.env.map_not_indexed")],
      ),
    );
  }

  function fmtTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
  }

  async function refresh() {
    const r = await api("/api/state");
    if (!r.ok || !r.data) return;
    renderState(r.data.state, r.data.busy);
  }

  async function loadConfig() {
    const r = await api("/api/config");
    if (!r.ok || !r.data) return;
    state.config = r.data.config || {};
    state.registry = Array.isArray(r.data.registry) ? r.data.registry : [];
    state.webToken = typeof r.data.webToken === "string" ? r.data.webToken : null;
    renderSelectors();
    renderSettings();
  }

  async function loadModels() {
    const r = await api("/api/models");
    if (!r.ok || !r.data) return;
    state.models = Array.isArray(r.data.models) ? r.data.models : [];
    renderSelectors();
  }

  async function loadProviders() {
    const r = await api("/api/providers");
    state.providers = r.ok && r.data && Array.isArray(r.data.entries) ? r.data : undefined;
    renderModelPanel();
  }

  async function loadSessions() {
    const r = await api("/api/sessions");
    if (!r.ok || !r.data) return;
    state.sessions = Array.isArray(r.data.sessions) ? r.data.sessions : [];
    renderSessionsDropdown();
  }

  // Connection-state banner: shown while the SSE stream is down. The server
  // never replays events, so a reconnect only resyncs state — the feed keeps
  // whatever the live session already rendered (no duplication).
  function setConnStatus(disconnected) {
    if (!connStatus) return;
    connStatus.hidden = !disconnected;
    connStatus.textContent = disconnected ? "⋯ " + t("web.conn.reconnecting") : "";
  }

  function resyncAfterReconnect() {
    refresh();
    const tab = tabs.find((x) => x.id === activeTabId);
    if (tab && tab.kind === "session" && !feedHasContent(tab.feed)) {
      tab.historyLoaded = false;
      loadHistory(tab);
    }
  }

  function connectSSE() {
    const sseUrl = "/events" + (token ? "?token=" + encodeURIComponent(token) : "");
    const es = new EventSource(sseUrl);
    let dropped = false;
    es.onopen = () => {
      if (!dropped) return;
      dropped = false;
      setConnStatus(false);
      resyncAfterReconnect();
    };
    es.onerror = (e) => {
      // A server-sent `event: error` also lands here but carries `data`; only a
      // real transport drop has none. Don't flag a live stream as disconnected.
      if (e && typeof e.data === "string") return;
      dropped = true;
      setConnStatus(true);
    };
    const parse = (e) => {
      try {
        return JSON.parse(e.data);
      } catch (err) {
        return null;
      }
    };
    es.addEventListener("text", (e) => {
      const d = parse(e);
      if (d) onText(d.chunk || "", d.sessionId);
    });
    es.addEventListener("meta", (e) => {
      const d = parse(e);
      if (d) onMeta(d.chunk || "", d.sessionId);
    });
    es.addEventListener("phase", (e) => {
      const d = parse(e);
      if (d) onPhase(d.phase, d.sessionId);
    });
    es.addEventListener("tool_start", (e) => {
      const d = parse(e);
      if (d) onToolStart(d);
    });
    es.addEventListener("tool_end", (e) => {
      const d = parse(e);
      if (d) onToolEnd(d);
    });
    es.addEventListener("plan", (e) => {
      const d = parse(e);
      if (d) onPlan(d);
    });
    es.addEventListener("question", (e) => {
      const d = parse(e);
      if (d) onQuestion(d);
    });
    es.addEventListener("turn_end", (e) => {
      const d = parse(e);
      if (d) onTurnEnd(d);
    });
    es.addEventListener("command", (e) => {
      const d = parse(e);
      if (d && typeof d.text === "string") onCommandOutput(d.text, d.sessionId);
    });
    es.addEventListener("log", (e) => {
      const d = parse(e);
      if (d) onLog(d);
    });
    es.addEventListener("state", (e) => {
      const d = parse(e);
      if (d) {
        state.busy = !!d.busy;
        reflectBusy();
        if (d.usage && typeof d.usage === "object") {
          state.host = Object.assign({}, state.host, d.usage);
          renderUsage(state.host);
        }
      }
    });
    es.addEventListener("error", (e) => {
      if (!e.data) return;
      const d = parse(e);
      if (d) onErrorEvent(d);
    });
  }

  const SECTION_KEYS = {
    general: ["locale", "ui.verbosity", "maxToolIterations", "stuckThreshold"],
    context: ["contextWindow", "contextBudget.systemPrompt", "contextBudget.responseReserve"],
    reasoning: ["showReasoning", "reasoning.mode"],
    security: [
      "security.enabled",
      "security.paths.enabled",
      "security.contentScan.enabled",
      "security.sessionEncryption.enabled",
    ],
    advanced: ["logLevel", "version"],
  };

  // Localized label for a registry key: `config.key.<canonical>`, falling back
  // to the raw key when no translation exists (so a new key is never blank).
  function configLabel(def) {
    const k = "config.key." + def.key;
    const tr = t(k);
    return tr === k ? def.key : tr;
  }

  // Localized enum value: `config.enum.<value>`, falling back to the raw value.
  // The raw value is still what gets POSTed — only the label is translated.
  function enumLabel(v) {
    const k = "config.enum." + v;
    const tr = t(k);
    return tr === k ? v : tr;
  }

  function defFor(key) {
    return state.registry.find((d) => d.key === key) || null;
  }

  function row(label, control, desc) {
    const r = el("div", "row");
    const left = el("div", "row-label");
    left.appendChild(el("span", "row-name", label));
    if (desc) left.appendChild(el("span", "row-desc", desc));
    r.appendChild(left);
    if (typeof control === "string") {
      const v = el("span", "val", control);
      v.title = control;
      r.appendChild(v);
    } else if (control) {
      r.appendChild(control);
    }
    return r;
  }

  function descFor(key) {
    const k = "config.desc." + key;
    const d = t(k);
    return d === k ? "" : d;
  }

  function configControl(def, key) {
    const value = state.config ? getPath(state.config, key) : undefined;
    if (def.valueType === "bool") {
      const toggle = el("button", "toggle" + (value ? " on" : ""));
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", value ? "true" : "false");
      toggle.addEventListener("click", () => {
        const next = !toggle.classList.contains("on");
        toggle.classList.toggle("on", next);
        toggle.setAttribute("aria-checked", next ? "true" : "false");
        postConfig(key, next, false);
      });
      return toggle;
    }
    if (def.valueType === "enum") {
      const seg = el("span", "seg");
      (def.enum || []).forEach((v) => {
        const b = el("button", v === value ? "on" : "", enumLabel(v));
        b.type = "button";
        b.setAttribute("aria-pressed", v === value ? "true" : "false");
        b.addEventListener("click", () => {
          seg.querySelectorAll("button").forEach((x) => {
            x.classList.remove("on");
            x.setAttribute("aria-pressed", "false");
          });
          b.classList.add("on");
          b.setAttribute("aria-pressed", "true");
          postConfig(key, v, false);
        });
        seg.appendChild(b);
      });
      return seg;
    }
    if (def.readOnly) {
      const ro = el("span", "val dim", value == null ? "—" : String(value));
      if (value != null) ro.title = String(value);
      return ro;
    }
    const input = el("input");
    input.setAttribute("aria-label", configLabel(def));
    if (def.valueType === "int") {
      input.type = "number";
      if (def.min != null) input.min = String(def.min);
      if (def.max != null) input.max = String(def.max);
      if (def.step != null) input.step = String(def.step);
      input.value = value == null ? "" : String(value);
    } else if (def.valueType === "share") {
      input.value = value == null ? "" : Math.round(Number(value) * 100) + "%";
    } else {
      input.value = value == null ? "" : String(value);
    }
    input.addEventListener("change", () => {
      postConfig(key, input.value, false);
    });
    return input;
  }

  function renderGenericPanel(name, keys) {
    const container = document.querySelector('[data-panel="' + name + '"]');
    if (!container) return;
    container.textContent = "";
    keys.forEach((key) => {
      const def = defFor(key);
      if (!def) return;
      container.appendChild(row(configLabel(def), configControl(def, key), descFor(def.key)));
    });
  }

  function providerEntries() {
    if (state.providers && Array.isArray(state.providers.entries) && state.providers.entries.length) {
      return state.providers.entries;
    }
    const provider = (state.config && state.config.provider) || {};
    if (Array.isArray(provider.entries) && provider.entries.length) {
      return provider.entries.map((e) => ({
        type: e.type,
        label: e.label || e.type,
        baseUrl: e.baseUrl,
        hasApiKey: !!e.apiKey,
        contextWindow: e.contextWindow,
        priority: e.priority,
      }));
    }
    return [
      {
        type: provider.type,
        label: provider.active || provider.type,
        baseUrl: provider.baseUrl,
        hasApiKey: !!provider.apiKey,
      },
    ];
  }

  function providerName(p) {
    return p.label || p.type || "—";
  }

  function providerMeta(p) {
    const parts = [p.type];
    if (p.contextWindow) parts.push(Math.round(p.contextWindow / 1024) + "K");
    if (typeof p.rpm === "number" || typeof p.parallel === "number") {
      parts.push("rpm " + (p.rpm == null ? "—" : p.rpm) + " · x" + (p.parallel == null ? "—" : p.parallel));
    }
    return parts.join(" · ");
  }

  function pfield(labelKey, input) {
    const f = el("div", "pform-field");
    f.appendChild(el("label", "", t(labelKey)));
    input.setAttribute("aria-label", t(labelKey));
    f.appendChild(input);
    return f;
  }

  function providerInput(value, type, placeholder) {
    const input = el("input");
    input.type = type || "text";
    if (placeholder) input.placeholder = placeholder;
    if (value != null) input.value = String(value);
    return input;
  }

  function providerForm() {
    const editing = (state.providerForm && state.providerForm.entry) || {};
    const box = el("div", "pform");
    const grid = el("div", "pform-grid");

    const fType = providerInput(editing.type, "text", "openai-compat");
    const fLabel = providerInput(editing.label, "text", "my-provider");
    const fBase = providerInput(editing.baseUrl, "text", "http://localhost:1234/v1");
    const fKey = providerInput("", "password", editing.hasApiKey ? t("web.settings.provider_key_keep") : "");
    const fCtx = providerInput(editing.contextWindow, "number", "32768");
    const fPrio = providerInput(editing.priority, "number", "0");
    const fRpm = providerInput(editing.rpm, "number", "60");
    const fPar = providerInput(editing.parallel, "number", "1");

    grid.appendChild(pfield("web.settings.provider_type", fType));
    grid.appendChild(pfield("web.settings.provider_label_field", fLabel));
    grid.appendChild(pfield("web.settings.provider_baseurl", fBase));
    grid.appendChild(pfield("web.settings.provider_apikey", fKey));
    grid.appendChild(pfield("web.settings.provider_context", fCtx));
    grid.appendChild(pfield("web.settings.provider_priority", fPrio));
    grid.appendChild(pfield("web.settings.provider_rpm", fRpm));
    grid.appendChild(pfield("web.settings.provider_parallel", fPar));
    box.appendChild(grid);

    const actions = el("div", "pform-actions");
    const save = link(t("web.settings.save"), "", async () => {
      const type = fType.value.trim();
      const baseUrl = fBase.value.trim();
      if (!type || !baseUrl) {
        setIndicator(t("web.settings.provider_required"), true);
        return;
      }
      const body = { type, baseUrl };
      const label = fLabel.value.trim();
      if (label) body.label = label;
      const key = fKey.value.trim();
      if (key && key !== "***") body.apiKey = key;
      const nums = [
        ["contextWindow", fCtx, 1024],
        ["priority", fPrio, 0],
        ["rpm", fRpm, 1],
        ["parallel", fPar, 1],
      ];
      for (const entry of nums) {
        const raw = entry[1].value.trim();
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < entry[2]) {
          setIndicator(t("web.settings.provider_invalid"), true);
          return;
        }
        body[entry[0]] = n;
      }
      const r = await api("/api/providers", { method: "POST", body });
      if (r.ok && r.data && r.data.ok) {
        const persisted = r.data.persisted !== false;
        state.providerForm = null;
        setIndicator(persisted ? t("web.settings.saved") : r.data.warning || "not persisted", !persisted);
        await loadProviders();
        await loadConfig();
      } else {
        setIndicator((r.data && r.data.error) || t("web.settings.save_failed"), true);
      }
    });
    const cancel = link(t("web.settings.cancel"), "dim", () => {
      state.providerForm = null;
      renderModelPanel();
    });
    actions.appendChild(save);
    actions.appendChild(cancel);
    box.appendChild(actions);
    return box;
  }

  function renderModelPanel() {
    const container = document.querySelector('[data-panel="model"]');
    if (!container) return;
    container.textContent = "";
    const cfg = state.config || {};

    const search = el("input", "searchbox");
    search.placeholder = t("web.settings.search_models");
    search.setAttribute("aria-label", t("web.settings.search_models"));
    container.appendChild(search);
    const list = el("div");
    container.appendChild(list);
    const draw = () => {
      list.textContent = "";
      const q = search.value.trim().toLowerCase();
      const models = state.models.filter((m) => !q || m.toLowerCase().indexOf(q) !== -1);
      if (!models.length) {
        list.appendChild(el("div", "placeholder", state.models.length ? t("web.settings.no_matches") : t("web.settings.no_models")));
        return;
      }
      models.forEach((m) => {
        const active = m === cfg.model;
        const r = el("div", "row");
        const nameEl = el("span", active ? "val accent" : "", m);
        nameEl.title = m;
        r.appendChild(nameEl);
        if (active) {
          r.appendChild(el("span", "val dim", contextLabel() + " · " + t("web.settings.active_check")));
        } else {
          r.appendChild(link(t("web.settings.use"), "", () => postConfig("model", m, true)));
        }
        list.appendChild(r);
      });
    };
    search.addEventListener("input", draw);
    draw();

    const entries = providerEntries();
    const activeName = (state.providers && state.providers.active) || cfg.provider?.active || cfg.provider?.type || "—";
    const activeVal = el("span", "val", activeName);
    activeVal.title = activeName;
    container.appendChild(row(t("web.settings.active_provider"), activeVal));

    const provList = el("div", "settings-list");
    entries.forEach((entry) => {
      const name = providerName(entry);
      if (!name || name === "—") return;
      const line = el("div", "list-line");
      const nameEl = el("span", "name", name);
      nameEl.title = name;
      line.appendChild(nameEl);
      line.appendChild(el("span", "src", providerMeta(entry)));
      if (name === activeName) {
        line.appendChild(el("span", "st", t("web.settings.active")));
      } else {
        line.appendChild(link(t("web.settings.use"), "", () => postConfig("provider.active", name, true)));
      }
      line.appendChild(
        link(t("web.settings.edit"), "", () => {
          state.providerForm = { mode: "edit", entry };
          renderModelPanel();
        }),
      );
      if (name !== activeName) {
        line.appendChild(
          link(t("web.settings.delete"), "danger", async () => {
            const r = await api("/api/providers/" + encodeURIComponent(name), { method: "DELETE" });
            if (r.ok && r.data && r.data.ok) {
              setIndicator(t("web.settings.saved"));
              await loadProviders();
              await loadConfig();
            } else {
              const err = (r.data && r.data.error) || t("web.settings.delete_failed");
              setIndicator(err === "active-provider" ? t("web.settings.provider_active_guard") : String(err), true);
            }
          }),
        );
      }
      provList.appendChild(line);
    });
    container.appendChild(provList);

    container.appendChild(
      link(t("web.settings.add_provider"), "add-provider", () => {
        state.providerForm = { mode: "add", entry: null };
        renderModelPanel();
      }),
    );
    if (state.providerForm) container.appendChild(providerForm());
  }

  function renderUiPanel() {
    const container = document.querySelector('[data-panel="ui"]');
    if (!container) return;
    container.textContent = "";
    const seg = el("span", "seg");
    ["dark", "light", "auto"].forEach((theme) => {
      const b = el("button", currentTheme() === theme ? "on" : "", theme);
      b.type = "button";
      b.setAttribute("aria-pressed", currentTheme() === theme ? "true" : "false");
      b.addEventListener("click", () => {
        seg.querySelectorAll("button").forEach((x) => {
          x.classList.remove("on");
          x.setAttribute("aria-pressed", "false");
        });
        b.classList.add("on");
        b.setAttribute("aria-pressed", "true");
        applyTheme(theme);
      });
      seg.appendChild(b);
    });
    container.appendChild(row(t("web.settings.theme"), seg));
  }

  function renderSecurityPanel() {
    const container = document.querySelector('[data-panel="security"]');
    if (!container) return;
    container.textContent = "";
    SECTION_KEYS.security.forEach((key) => {
      const def = defFor(key);
      if (!def) return;
      container.appendChild(row(configLabel(def), configControl(def, key), descFor(def.key)));
    });
    container.appendChild(
      row(t("web.settings.web_token"), el("span", "val dim", state.webToken || t("web.settings.web_token_none")), t("config.desc.webToken")),
    );
    const note = el("div", "placeholder");
    note.appendChild(el("span", "tag", t("web.settings.terminal_tag")));
    note.appendChild(document.createTextNode(" " + t("web.settings.security_note")));
    container.appendChild(note);
  }

  function placeholderFor(data, empty) {
    const d = el("div", "placeholder");
    if (data === undefined) d.textContent = t("web.settings.loading");
    else d.textContent = empty;
    return d;
  }

  function groupHeader(label, count) {
    const head = el("div", "row");
    head.appendChild(el("span", "val accent", label));
    if (count != null) head.appendChild(el("span", "val dim", String(count)));
    return head;
  }

  const MEMORY_CATEGORIES = ["conventions", "decisions", "errors", "facts"];

  function renderMemoryPanel() {
    const container = document.querySelector('[data-panel="memory"]');
    if (!container) return;
    container.textContent = "";
    if (state.memory === undefined || state.memory === null) {
      container.appendChild(placeholderFor(state.memory, t("web.settings.memory_unavailable")));
      return;
    }
    const data = state.memory;

    const addRow = el("div", "mem-add");
    const catSel = el("select");
    catSel.setAttribute("aria-label", t("web.settings.memory_category"));
    MEMORY_CATEGORIES.forEach((c) => catSel.appendChild(el("option", "", c)));
    catSel.value = "facts";
    addRow.appendChild(catSel);
    const textIn = el("input");
    textIn.placeholder = t("web.settings.new_memory");
    textIn.setAttribute("aria-label", t("web.settings.new_memory"));
    addRow.appendChild(textIn);
    addRow.appendChild(
      link(t("web.settings.add"), "", async () => {
        const text = textIn.value.trim();
        if (!text) return;
        const r = await api("/api/memory", { method: "POST", body: { category: catSel.value, text } });
        if (r.ok && r.data && r.data.ok) {
          textIn.value = "";
          await loadMemory();
        } else {
          setIndicator(t("web.settings.add_failed"), true);
        }
      }),
    );
    container.appendChild(addRow);

    const search = el("input", "searchbox");
    search.placeholder = t("web.settings.search_memory");
    search.setAttribute("aria-label", t("web.settings.search_memory"));
    container.appendChild(search);
    const list = el("div", "settings-list");
    container.appendChild(list);

    const categoryHeader = (label, count) => {
      const head = el("div", "mem-cat");
      head.appendChild(el("span", "", label));
      if (count != null) head.appendChild(el("span", "n", String(count)));
      return head;
    };

    const entryBlock = (text, onForget) => {
      const block = el("div", "mem-entry");
      const body = el("span", "mem-text");
      body.appendChild(inlineTextNodes(text));
      body.title = String(text == null ? "" : text);
      block.appendChild(body);
      if (onForget) block.appendChild(link(t("web.settings.forget"), "mem-del", onForget));
      return block;
    };

    const draw = () => {
      list.textContent = "";
      const q = search.value.trim().toLowerCase();
      let any = false;
      (data.categories || []).forEach((cat) => {
        const entries = (cat.entries || []).filter(
          (e) => !q || String(e.text).toLowerCase().indexOf(q) !== -1,
        );
        if (!entries.length) return;
        any = true;
        list.appendChild(categoryHeader(cat.name, entries.length));
        entries.forEach((e) => {
          list.appendChild(
            entryBlock(e.text, async () => {
              const r = await api(
                "/api/memory/" + encodeURIComponent(cat.name) + "/" + e.n,
                { method: "DELETE" },
              );
              if (r.ok) await loadMemory();
              else setIndicator(t("web.settings.forget_failed"), true);
            }),
          );
        });
      });
      const prefs = Object.entries(data.preferences || {});
      if (prefs.length && !q) {
        any = true;
        list.appendChild(categoryHeader(t("web.settings.preferences"), prefs.length));
        prefs.forEach(([k, v]) => {
          list.appendChild(entryBlock(k + " = " + v));
        });
      }
      if (!any) {
        const empty = el("div", "placeholder");
        empty.textContent = q ? t("web.settings.no_matches") : t("web.settings.no_memory");
        list.appendChild(empty);
      }
    };
    search.addEventListener("input", draw);
    draw();
  }

  function renderSkillsPanel() {
    const container = document.querySelector('[data-panel="skills"]');
    if (!container) return;
    container.textContent = "";
    if (state.skills === undefined || state.skills === null) {
      container.appendChild(placeholderFor(state.skills, t("web.settings.skills_unavailable")));
      return;
    }
    if (!state.skills.length) {
      const empty = el("div", "placeholder");
      empty.textContent = t("web.settings.no_skills");
      container.appendChild(empty);
      return;
    }
    const list = el("div", "settings-list");
    state.skills.forEach((s) => {
      const item = el("div", "skill-item");
      const head = el("div", "skill-head");
      head.appendChild(el("span", s.enabled ? "g" : "dim", s.enabled ? "✓" : "○"));
      const nameEl = el("span", "name", s.name);
      nameEl.title = s.name;
      head.appendChild(nameEl);
      head.appendChild(el("span", "st", s.enabled ? t("web.settings.enabled") : t("web.settings.available")));
      item.appendChild(head);
      if (s.source) {
        const src = el("div", "skill-src", s.source);
        src.title = s.source;
        item.appendChild(src);
      }
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  function renderPluginsPanel() {
    const container = document.querySelector('[data-panel="plugins"]');
    if (!container) return;
    container.textContent = "";
    if (state.pluginsData === undefined || state.pluginsData === null) {
      container.appendChild(placeholderFor(state.pluginsData, t("web.settings.plugins_unavailable")));
      return;
    }
    const data = state.pluginsData;
    const list = el("div", "settings-list");
    list.appendChild(groupHeader(t("web.settings.plugins_header"), (data.plugins || []).length));
    if (!(data.plugins || []).length) {
      const empty = el("div", "placeholder");
      empty.textContent = t("web.settings.no_plugins");
      list.appendChild(empty);
    }
    (data.plugins || []).forEach((p) => {
      const line = el("div", "list-line");
      line.appendChild(el("span", "g", "✓"));
      const nameEl = el("span", "name", p.name);
      nameEl.title = p.name;
      line.appendChild(nameEl);
      if (p.version) line.appendChild(el("span", "src", "v" + p.version));
      if (p.source) {
        const src = el("span", "src", p.source);
        src.title = p.source;
        line.appendChild(src);
      }
      if (p.builtin) line.appendChild(el("span", "src", t("web.settings.builtin")));
      line.appendChild(el("span", "st", p.enabled === false ? t("web.settings.disabled") : t("web.settings.enabled")));
      list.appendChild(line);
    });
    const pnote = el("div", "settings-note");
    pnote.textContent = t("web.settings.plugins_note");
    list.appendChild(pnote);

    list.appendChild(groupHeader(t("web.settings.mcp_servers"), (data.mcp || []).length));
    if (!(data.mcp || []).length) {
      const empty = el("div", "placeholder");
      empty.textContent = t("web.settings.no_mcp");
      list.appendChild(empty);
    }
    (data.mcp || []).forEach((m) => {
      const line = el("div", "list-line");
      const on = m.status !== "disabled";
      const toggle = el("button", "toggle" + (on ? " on" : ""));
      toggle.type = "button";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", on ? "true" : "false");
      toggle.title = on ? t("web.settings.mcp_disable") : t("web.settings.mcp_enable");
      toggle.setAttribute("aria-label", toggle.title);
      toggle.addEventListener("click", async () => {
        const next = !toggle.classList.contains("on");
        const r = await api("/api/mcp/" + encodeURIComponent(m.id || m.name), {
          method: "POST",
          body: { enabled: next },
        });
        if (r.ok && r.data && r.data.ok) {
          setIndicator(t("web.settings.mcp_saved"), false);
          await loadPlugins();
        } else {
          setIndicator(t("web.settings.save_failed"), true);
        }
      });
      line.appendChild(toggle);
      const nameEl = el("span", "name", m.name);
      nameEl.title = m.name;
      line.appendChild(nameEl);
      line.appendChild(el("span", "st", m.status || "—"));
      list.appendChild(line);
    });
    if ((data.mcp || []).length) {
      const mnote = el("div", "settings-note");
      mnote.textContent = t("web.settings.mcp_note");
      list.appendChild(mnote);
    }
    container.appendChild(list);
  }

  async function loadMemory() {
    const r = await api("/api/memory");
    state.memory = r.ok && r.data ? r.data : null;
    renderMemoryPanel();
  }

  async function loadSkills() {
    const r = await api("/api/skills");
    state.skills = r.ok && r.data && Array.isArray(r.data.skills) ? r.data.skills : null;
    renderSkillsPanel();
  }

  async function loadPlugins() {
    const r = await api("/api/plugins");
    state.pluginsData =
      r.ok && r.data
        ? { plugins: r.data.plugins || [], mcp: r.data.mcp || [] }
        : null;
    renderPluginsPanel();
  }

  function renderSettings() {
    renderGenericPanel("general", SECTION_KEYS.general);
    renderModelPanel();
    renderGenericPanel("context", SECTION_KEYS.context);
    renderGenericPanel("reasoning", SECTION_KEYS.reasoning);
    renderUiPanel();
    renderMemoryPanel();
    renderSkillsPanel();
    renderPluginsPanel();
    renderSecurityPanel();
    renderGenericPanel("advanced", SECTION_KEYS.advanced);
  }

  // Re-apply the dictionary to static chrome after a locale switch. Dynamic
  // feeds (tool output, model text) are localized server-side and untouched.
  function applyStaticI18n() {
    document.documentElement.lang = I18N.locale;
    const setText = (id, text) => {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    };
    setText("planHeaderLabel", t("web.sidebar.plan"));
    setText("usageHeaderLabel", t("web.sidebar.session") + " · " + t("web.sidebar.usage"));
    setText("envHeaderLabel", t("web.sidebar.env"));
    setText("settingsTitle", t("web.settings.title"));
    setText("sessActiveHeader", t("web.sessions.active"));
    setText("sessRecentHeader", t("web.sessions.recent"));
    setText("hintEnter", t("web.input.enter"));
    setText("hintShift", t("web.input.shift_enter"));
    setText("hintEsc", t("web.input.esc"));
    setText("hintAttach", t("web.input.attach"));

    // Chrome controls: Lucide icon + label, plus matching title/aria-label.
    const controls = {
      newChat: ["plus", t("web.topbar.new_chat")],
      sessBtn: ["menu", t("web.topbar.all_sessions")],
      openSettings: ["settings", t("web.topbar.settings")],
      attachBtn: ["image", t("web.attach.title")],
      closeSettings: ["x", t("web.topbar.close")],
      sessNew: ["plus", t("web.sessions.new")],
      sessRefresh: ["refresh", t("web.sessions.refresh")],
    };
    Object.keys(controls).forEach((id) => {
      const node = document.getElementById(id);
      if (!node) return;
      const [name, label] = controls[id];
      // Text-bearing buttons keep their label; icon-only ones don't add one.
      const withLabel = id === "closeSettings" || id === "sessNew" || id === "sessRefresh";
      setIcon(node, name, withLabel ? label : null);
      node.title = label;
      node.setAttribute("aria-label", label);
    });
    const settingsIcon = document.getElementById("settingsIcon");
    if (settingsIcon) setIcon(settingsIcon, "settings", null);
    if (inp) {
      inp.placeholder = t("web.input.placeholder");
      inp.setAttribute("aria-label", t("web.input.placeholder"));
    }

    document.querySelectorAll("#setMenu .mi").forEach((mi) => {
      const p = mi.dataset.p;
      if (p) mi.textContent = t("web.settings." + p);
    });
    document.querySelectorAll(".content-col .panel").forEach((panel) => {
      const h3 = panel.querySelector("h3");
      const name = panel.id.replace(/^p-/, "");
      if (h3 && name) h3.textContent = t("web.settings." + name);
    });

    renderSelectors();
    renderSessionsDropdown();
    if (msgs.querySelector(".empty")) showEmptyFeed();
    if (connStatus && !connStatus.hidden) setConnStatus(true);
  }

  const overlay = document.getElementById("overlay");
  const settingsBtn = document.getElementById("openSettings");
  const closeSettingsBtn = document.getElementById("closeSettings");
  let settingsReturnFocus = null;

  // Settings sections act as a real tablist: roles, roving tabindex, arrow keys.
  const settingsTabs = Array.from(document.querySelectorAll("#setMenu .mi"));
  function selectSettingsPanel(name) {
    settingsTabs.forEach((x) => {
      const on = x.dataset.p === name;
      x.classList.toggle("on", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
      x.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll(".content-col .panel").forEach((x) => x.classList.remove("on"));
    const panel = document.getElementById("p-" + name);
    if (panel) panel.classList.add("on");
  }
  settingsTabs.forEach((mi) => {
    const name = mi.dataset.p;
    mi.setAttribute("role", "tab");
    mi.setAttribute("id", "tab-" + name);
    mi.setAttribute("aria-controls", "p-" + name);
    mi.setAttribute("aria-selected", mi.classList.contains("on") ? "true" : "false");
    mi.tabIndex = mi.classList.contains("on") ? 0 : -1;
    mi.addEventListener("click", () => selectSettingsPanel(name));
    mi.addEventListener("keydown", (e) => {
      const i = settingsTabs.indexOf(mi);
      let next = null;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") next = settingsTabs[(i + 1) % settingsTabs.length];
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = settingsTabs[(i - 1 + settingsTabs.length) % settingsTabs.length];
      else if (e.key === "Home") next = settingsTabs[0];
      else if (e.key === "End") next = settingsTabs[settingsTabs.length - 1];
      if (next) {
        e.preventDefault();
        selectSettingsPanel(next.dataset.p);
        next.focus();
      }
    });
  });
  document.querySelectorAll(".content-col .panel").forEach((panel) => {
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "tab-" + panel.id.replace(/^p-/, ""));
  });

  function openSettings() {
    settingsReturnFocus = document.activeElement;
    overlay.classList.add("open");
    settingsBtn.setAttribute("aria-expanded", "true");
    void loadMemory();
    void loadSkills();
    void loadPlugins();
    const active = document.querySelector("#setMenu .mi.on") || settingsTabs[0];
    if (active) setTimeout(() => active.focus(), 0);
  }
  function closeSettings() {
    overlay.classList.remove("open");
    settingsBtn.setAttribute("aria-expanded", "false");
    if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
    settingsReturnFocus = null;
  }
  settingsBtn.addEventListener("click", openSettings);
  closeSettingsBtn.addEventListener("click", closeSettings);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeSettings();
  });
  // Trap Tab inside the dialog while it is open.
  overlay.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = Array.from(
      overlay.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((node) => node.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closeSettings();
  });

  // --- generic confirmation dialog (alertdialog) -------------------------
  const confirmOverlay = document.getElementById("confirmOverlay");
  const confirmTitle = document.getElementById("confirmTitle");
  const confirmMsg = document.getElementById("confirmMsg");
  const confirmAccept = document.getElementById("confirmAccept");
  const confirmCancel = document.getElementById("confirmCancel");
  let confirmOnAccept = null;
  let confirmReturnFocus = null;

  function openConfirm(opts) {
    if (!confirmOverlay) return;
    confirmReturnFocus = document.activeElement;
    confirmTitle.textContent = opts.title || "";
    confirmMsg.textContent = opts.body || "";
    confirmAccept.textContent = opts.acceptLabel || t("web.sessions.delete");
    confirmCancel.textContent = opts.cancelLabel || t("web.action.cancel");
    confirmOnAccept = opts.onAccept || null;
    confirmOverlay.classList.add("open");
    setTimeout(() => confirmCancel.focus(), 0);
  }

  function closeConfirm() {
    if (!confirmOverlay || !confirmOverlay.classList.contains("open")) return;
    confirmOverlay.classList.remove("open");
    confirmOnAccept = null;
    if (confirmReturnFocus && confirmReturnFocus.focus) confirmReturnFocus.focus();
    confirmReturnFocus = null;
  }

  if (confirmOverlay) {
    confirmCancel.addEventListener("click", closeConfirm);
    confirmAccept.addEventListener("click", () => {
      const fn = confirmOnAccept;
      closeConfirm();
      if (fn) fn();
    });
    confirmOverlay.addEventListener("click", (e) => {
      // Keep clicks inside the dialog from reaching the global handler, so the
      // sessions dropdown stays open behind it.
      e.stopPropagation();
      if (e.target === confirmOverlay) closeConfirm();
    });
    // Keep Tab between the two actions while the dialog is open.
    confirmOverlay.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      (document.activeElement === confirmAccept ? confirmCancel : confirmAccept).focus();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (confirmOverlay && confirmOverlay.classList.contains("open")) closeConfirm();
    else if (overlay.classList.contains("open")) closeSettings();
  });

  function currentTheme() {
    return localStorage.getItem(THEME_KEY) || "auto";
  }

  function applyTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    const light = theme === "light" || (theme === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
    document.body.classList.toggle("light", !!light);
    renderUiPanel();
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      if (currentTheme() === "auto") applyTheme("auto");
    });
  }

  async function boot() {
    await loadI18n();
    await loadCommands();
    applyTheme(currentTheme());
    applyStaticI18n();
    showEmptyFeed();
    renderSelectors();
    renderSettings();
    await loadConfig();
    await loadModels();
    await loadProviders();
    await loadSessions();
    await loadMemory();
    await loadSkills();
    await loadPlugins();
    await refresh();
    connectSSE();
    setInterval(refresh, 2000);
    setInterval(loadSessions, 15000);
  }

  boot();
})();
