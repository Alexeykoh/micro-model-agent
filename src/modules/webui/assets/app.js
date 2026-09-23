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
  const saveIndicator = document.getElementById("saveIndicator");
  const attachStrip = document.getElementById("attachStrip");
  const attachErr = document.getElementById("attachErr");
  const imgPicker = document.getElementById("imgPicker");
  const connStatus = document.getElementById("connStatus");

  const LABELS = {
    read_file: "Reading file",
    list_dir: "Listing directory",
    glob: "Finding files",
    grep: "Searching",
    file_info: "File info",
    project_map: "Project map",
    chunk_query: "Querying",
    web_search: "Web search",
    web_fetch: "Fetching URL",
    history: "History",
    recall: "Recall",
    process_list: "Listing processes",
    process_log: "Process log",
    write_file: "Writing file",
    edit_file: "Editing file",
    create_dir: "Creating directory",
    delete_file: "Deleting file",
    move_file: "Moving file",
    attach_image: "Attaching image",
    bash: "Running command",
    process_kill: "Killing process",
    pipeline_run: "Running pipeline",
    browser: "Browser",
    download_file: "Downloading",
    subagent: "Subagent",
    mcp_call: "MCP call",
    plan: "Plan",
    todo: "Todo",
    verify: "Verify",
    lsp_check: "LSP check",
    enable_tools: "Enable tools",
    set_thinking: "Thinking",
    load_skill: "Loading skill",
    remember: "Memory",
  };

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

  function labelOf(name) {
    return LABELS[name] || String(name).replace(/_/g, " ");
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
    const hint = el("span", "", t("web.empty.hint"));
    hint.style.color = "#9198a1";
    wrap.appendChild(hint);
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
    const t = tabs.find((x) => x.feed === feed);
    if (t) t.planCard = null;
    if (feed === activeFeed()) scroll();
  }

  function activeFeed() {
    const t = tabs.find((x) => x.id === activeTabId);
    return t ? t.feed : null;
  }

  function liveFeed() {
    const t = tabs.find((x) => x.id === liveTabId) || tabs.find((x) => x.id === activeTabId);
    return t ? t.feed : null;
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

  function clearBusy() {
    if (busyTimer) {
      clearInterval(busyTimer);
      busyTimer = null;
    }
    const feed = liveFeed();
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
    line.appendChild(document.createTextNode(" " + t("web.action.actions", { count: runCount }) + fails));
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

  function onText(chunk) {
    clearBusy();
    const feed = liveFeed();
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

  function onMeta(chunk) {
    clearBusy();
    const feed = liveFeed();
    if (!feed) return;
    clearEmpty(feed);
    curText = null;
    if (!curMeta) {
      flushRun();
      const wrap = el("div", "think");
      const head = el("div", "think-h");
      head.appendChild(el("span", "g", "✦"));
      head.appendChild(el("span", "lab", t("web.action.thinking")));
      head.appendChild(el("span", "dur", ""));
      head.appendChild(el("span", "tog", t("web.action.hide")));
      const body = el("div", "think-body");
      wrap.appendChild(head);
      wrap.appendChild(body);
      appendTo(feed, wrap);
      curMeta = { wrap, head, body, startedAt: Date.now() };
    }
    curMeta.body.textContent += chunk;
    if (feed === activeFeed()) scroll();
  }

  function onPhase(phase) {
    if (phase === "thinking") {
      showBusy();
    } else {
      clearBusy();
    }
  }

  function onToolStart(data) {
    clearBusy();
    const feed = liveFeed();
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
      const outLabel = "▸ " + t("web.tool.output", { count: text.length });
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

  function cardFor(name, args) {
    const feed = liveFeed();
    if (!feed) return;
    if (FILE_TOOLS.indexOf(name) !== -1) {
      const path = args.path || args.file || args.dir;
      if (!path) return;
      const card = el("div", "filecard");
      card.appendChild(el("span", "g", "◇"));
      card.appendChild(el("span", "name", path));
      card.appendChild(el("span", "", labelOf(name)));
      card.appendChild(el("span", "meta", t("web.card.view")));
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
    if (data.success) cardFor(data.name, args);
    renderToolOutput(line, data.output);
  }

  function onTurnEnd(data) {
    state.busy = false;
    clearBusy();
    finishMeta();
    curText = null;
    flushRun();
    const live = tabs.find((x) => x.id === liveTabId);
    if (live) live.planCard = null;
    const feed = liveFeed();
    if (!feed) return;
    if (data.success === false) {
      if (data.interrupted) {
        appendTo(feed, el("div", "warnline", "⚠ " + t("web.turn.stopped")));
      } else {
        appendTo(feed, el("div", "errline", "✗ " + t("web.turn.failed")));
      }
    } else {
      const parts = [];
      if (typeof data.toolCalls === "number" && data.toolCalls > 0) parts.push(data.toolCalls + " tools");
      if (typeof data.durationMs === "number") parts.push(formatMs(data.durationMs));
      if (parts.length) appendTo(feed, el("div", "metric", "⟡ " + parts.join(" · ")));
      appendTo(feed, el("div", "sysline", "— " + t("web.turn.end", { count: data.toolCalls || 0 }) + " —"));
    }
  }

  function onErrorEvent(data) {
    if (!data || !data.error) return;
    append(el("div", "errline", "✗ " + data.error));
  }

  function onCommandOutput(text) {
    const feed = liveFeed() || activeFeed();
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
    const feed = liveFeed() || activeFeed();
    if (!feed) return;
    const level = data.level;
    const cls = level === "error" ? "errline" : level === "warn" ? "warnline" : "detail";
    const glyph = level === "error" ? "✗ " : level === "warn" ? "⚠ " : "↳ ";
    const line = el("div", cls);
    line.textContent = glyph + data.text;
    appendTo(feed, line);
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
    const head = el("div", "think-h");
    head.appendChild(el("span", "g", "✦"));
    head.appendChild(el("span", "lab", t("web.action.thinking")));
    head.appendChild(el("span", "tog", t("web.action.hide")));
    const body = el("div", "think-body");
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
      const tab = el("div", "stab" + (item.id === activeTabId ? " on" : ""));
      tab.appendChild(el("span", "name", item.name || item.id));
      if (item.kind === "session") tab.appendChild(el("span", "sid", String(item.id).slice(0, 4)));
      const x = el("span", "x", "✕");
      x.title = t("web.topbar.close");
      tab.appendChild(x);
      tab.addEventListener("click", (e) => {
        if (e.target.classList.contains("x")) {
          closeTab(item.id);
          return;
        }
        openTab(item.id, item.name, item.kind, true);
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
    let t = tabs.find((x) => x.id === id);
    if (!t) {
      t = {
        id,
        name: name || id,
        kind: kind || "session",
        feed: makeFeed(),
        historyLoaded: false,
        historyLoading: false,
        planCard: null,
      };
      tabs.push(t);
    } else if (name) {
      t.name = name;
    }
    activeTabId = id;
    liveTabId = id;
    msgs.replaceChildren(t.feed);
    renderTabstrip();
    renderSessionsDropdown();
    msgs.scrollTop = msgs.scrollHeight;
    if (t.kind === "session" && !server) {
      // Auto-opened live session: SSE fills the feed, no transcript fetch.
      t.historyLoaded = true;
    }
    if (server && t.kind === "session") {
      api("/api/sessions/activate", { method: "POST", body: { id } }).then(() => loadSessions());
      loadHistory(t);
    }
  }

  function closeTab(id) {
    const i = tabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    tabs = tabs.filter((t) => t.id !== id);
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
    document.getElementById("sessDD").classList.remove("open");
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
  }

  function sessionRow(s, isActive) {
    const row = el("div", "si" + (isActive ? " on" : ""));
    row.appendChild(el("span", "id", String(s.id).slice(0, 4)));
    row.appendChild(el("span", "name", s.name || String(s.id)));
    row.appendChild(el("span", "meta", relTime(s.updatedAt)));
    const del = el("span", "del", "✕");
    del.title = t("web.sessions.delete");
    row.appendChild(del);
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) {
        e.stopPropagation();
        deleteSession(s.id);
        return;
      }
      document.getElementById("sessDD").classList.remove("open");
      openTab(s.id, s.name || s.id, "session", true);
    });
    return row;
  }

  async function deleteSession(id) {
    const r = await api("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.ok) setIndicator(t("web.sessions.delete_failed"), true);
    await loadSessions();
  }

  const sessDD = document.getElementById("sessDD");
  document.getElementById("sessBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
    sessDD.classList.toggle("open");
  });

  document.addEventListener("click", () => {
    document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
    sessDD.classList.remove("open");
  });

  msgs.addEventListener("click", (e) => {
    const head = e.target.closest(".think-h");
    if (!head) return;
    const body = head.nextElementSibling;
    if (!body) return;
    const hidden = body.classList.toggle("hidden");
    const tog = head.querySelector(".tog");
    if (tog) tog.textContent = hidden ? "▸ show" : "▾ hide";
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
      const rm = el("span", "rm", "✕");
      rm.title = t("web.attach.remove");
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

  async function send() {
    const text = inp.value.trim();
    const images = attachments.slice();
    if ((!text && !images.length) || state.busy) return;
    const feed = liveFeed() || activeFeed();
    clearEmpty(feed);
    curText = null;
    finishMeta();
    if (text.startsWith("/")) {
      appendTo(feed, el("div", "u", text));
      inp.value = "";
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
      banner.appendChild(document.createTextNode("start: "));
      banner.appendChild(el("b", "", (state.config && state.config.model) || state.host.model || "—"));
      banner.appendChild(document.createTextNode(" · " + (state.host.provider || (state.config && state.config.provider && state.config.provider.active) || "—") + " · " + contextLabel() + (state.host.sessionId ? " · session " + String(state.host.sessionId).slice(0, 4) : "")));
      feed.insertBefore(banner, feed.firstChild);
    }
    appendTo(feed, userMessageNode(text, images));
    inp.value = "";
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      interrupt();
    }
  });

  document.querySelectorAll("[data-collapse]").forEach((head) => {
    head.addEventListener("click", () => {
      const body = head.nextElementSibling;
      if (!body) return;
      const collapsed = body.classList.toggle("collapsed");
      const arrow = head.querySelector(".arrow");
      if (arrow) arrow.textContent = collapsed ? "▸" : "▾";
    });
  });

  function contextLabel() {
    const n = (state.config && state.config.contextWindow) || 0;
    return n ? Math.round(n / 1024) + "K" : "—";
  }

  function setSelButton(btn, label, value) {
    btn.textContent = label + ": ";
    btn.appendChild(el("b", "", value));
    btn.appendChild(document.createTextNode(" ▾"));
  }

  function closeAllMenus() {
    document.querySelectorAll("[data-sel]").forEach((s) => s.classList.remove("open"));
    const dd = document.getElementById("sessDD");
    if (dd) dd.classList.remove("open");
  }

  function menuItem(label, sub, active, onClick) {
    const mi = el("div", "mi" + (active ? " on" : ""));
    mi.appendChild(el("span", "", label));
    if (sub) mi.appendChild(el("span", "sub", sub));
    mi.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      closeAllMenus();
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
    const refresh = el("div", "mi", t("web.selectors.refresh_list"));
    refresh.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllMenus();
      loadModels().then(renderSelectors);
    });
    modelMenu.appendChild(refresh);

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
    const custom = el("div", "mi", t("web.selectors.custom"));
    custom.addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllMenus();
      const raw = window.prompt(t("web.selectors.context_prompt"), String(cfg.contextWindow || 32768));
      if (raw == null) return;
      const n = Number(raw.trim());
      if (Number.isFinite(n) && n >= 1024) postConfig("contextWindow", n, false);
    });
    ctxMenu.appendChild(custom);
  }

  document.querySelectorAll("[data-sel]").forEach((sel) => {
    const btn = sel.querySelector("button");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      sessDD.classList.remove("open");
      document.querySelectorAll("[data-sel]").forEach((s) => {
        if (s !== sel) s.classList.remove("open");
      });
      sel.classList.toggle("open");
    });
  });

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

  function renderState(snapshot, busy) {
    state.host = snapshot || {};
    state.busy = !!busy;
    const sessionId = state.host.sessionId || null;
    state.activeSessionId = sessionId;
    if (sessionId && !tabs.some((t) => t.id === sessionId)) {
      openTab(sessionId, state.host.sessionName || String(sessionId), "session", false);
    }
    if (!tabs.length) showEmptyFeed();
    renderPlan(state.host.plan);
    renderUsage(state.host);
    renderSessionsDropdown();
  }

  function renderPlan(plan) {
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
    const feed = liveFeed();
    if (!feed || !data || !Array.isArray(data.steps) || !data.steps.length) return;
    clearEmpty(feed);
    const tab = tabs.find((x) => x.id === liveTabId);
    let card = tab ? tab.planCard : null;
    if (!card || card.parentNode !== feed) {
      card = el("div", "planblock");
      appendTo(feed, card);
      if (tab) tab.planCard = card;
    }
    card.textContent = "";
    const total = data.steps.length;
    const cur = typeof data.currentIndex === "number" ? data.currentIndex : -1;
    card.appendChild(el("div", "ph2", "◇ " + t("web.plan.heading", { count: total })));
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
    const feed = liveFeed();
    if (!feed) return;
    clearEmpty(feed);
    const promptText = questionLabel(data.text);
    const block = el("div", "q");
    block.appendChild(el("div", "qtext", promptText));
    let answered = false;

    const settle = (value) => {
      if (answered) return;
      answered = true;
      const answer = Array.isArray(value)
        ? value
            .map((i) => data.options && data.options[i])
            .filter((x) => x != null)
            .join(", ")
        : String(value == null ? "" : value);
      block.classList.add("answered");
      block.textContent = "";
      block.appendChild(el("div", "qtext", promptText));
      block.appendChild(el("div", "qans", "↳ " + (answer || t("web.question.answered"))));
      api("/api/answer", { method: "POST", body: { id: data.id, value } });
      if (feed === activeFeed()) scroll();
    };

    if (data.kind === "choice" && Array.isArray(data.options) && data.options.length) {
      const multiple = !!data.multiple;
      const opts = el("div", "opts");
      const selected = [];
      let sendBtn = null;
      data.options.forEach((label, i) => {
        const row = el("div", "qopt", i + 1 + ". " + label);
        row.addEventListener("click", () => {
          if (answered) return;
          if (multiple) {
            const pos = selected.indexOf(i);
            if (pos === -1) {
              selected.push(i);
              row.classList.add("on");
            } else {
              selected.splice(pos, 1);
              row.classList.remove("on");
            }
            if (sendBtn) sendBtn.disabled = selected.length === 0;
          } else {
            settle([i]);
          }
        });
        opts.appendChild(row);
      });
      block.appendChild(opts);
      if (multiple) {
        sendBtn = el("button", "qsend", t("web.question.send"));
        sendBtn.disabled = true;
        sendBtn.addEventListener("click", () => {
          if (!answered && selected.length) {
            settle(selected.slice().sort((a, b) => a - b));
          }
        });
        block.appendChild(sendBtn);
      }
    } else {
      const input = el("input", "qinput");
      input.type = "text";
      input.placeholder = t("web.question.placeholder");
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          settle(input.value);
        }
      });
      block.appendChild(input);
      if (feed === activeFeed()) setTimeout(() => input.focus(), 0);
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
    usageEl.textContent = "";
    const sid = h.sessionId ? String(h.sessionId).slice(0, 8) : "—";
    usageEl.appendChild(usageRow("session", sid));
    usageEl.appendChild(usageRow("model", h.model || (state.config && state.config.model) || "—"));
    const used = typeof h.contextUsed === "number" ? h.contextUsed : null;
    const limit = typeof h.contextLimit === "number" ? h.contextLimit : (state.config && state.config.contextWindow) || null;
    usageEl.appendChild(usageRow("context", used != null && limit ? fmtTokens(used) + " / " + fmtTokens(limit) : "—"));
    if (used != null && limit) {
      const bar = el("div", "bar");
      const fill = el("i");
      fill.style.width = Math.min(100, Math.round((used / limit) * 100)) + "%";
      bar.appendChild(fill);
      usageEl.appendChild(bar);
    }
    const hit = typeof h.cacheHitRate === "number" ? h.cacheHitRate : null;
    usageEl.appendChild(usageRow("cache", hit != null ? Math.round(hit * 100) + "%" : "—", hit != null ? "" : "dim"));
    usageEl.appendChild(usageRow("cost", typeof h.costUsd === "number" ? "$" + h.costUsd.toFixed(4) : "—"));
    usageEl.appendChild(usageRow("compactions", "⟳ " + (h.compactionCount || 0), h.compactionCount ? "wn" : "dim"));
    const q = typeof h.contextQuality === "number" ? h.contextQuality : null;
    usageEl.appendChild(usageRow("quality", q != null ? Math.round(q) + "%" : "—", q != null ? "" : "dim"));
    usageEl.appendChild(usageRow("probe", "—", "dim"));
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
      if (d) onText(d.chunk || "");
    });
    es.addEventListener("meta", (e) => {
      const d = parse(e);
      if (d) onMeta(d.chunk || "");
    });
    es.addEventListener("phase", (e) => {
      const d = parse(e);
      if (d) onPhase(d.phase);
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
      if (d && typeof d.text === "string") onCommandOutput(d.text);
    });
    es.addEventListener("log", (e) => {
      const d = parse(e);
      if (d) onLog(d);
    });
    es.addEventListener("state", (e) => {
      const d = parse(e);
      if (d) {
        state.busy = !!d.busy;
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
      const t = el("span", "toggle" + (value ? " on" : ""));
      t.addEventListener("click", () => {
        const next = !t.classList.contains("on");
        t.classList.toggle("on", next);
        postConfig(key, next, false);
      });
      return t;
    }
    if (def.valueType === "enum") {
      const seg = el("span", "seg");
      (def.enum || []).forEach((v) => {
        const b = el("button", v === value ? "on" : "", enumLabel(v));
        b.addEventListener("click", () => {
          seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
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
    const save = el("span", "edit", t("web.settings.save"));
    save.addEventListener("click", async () => {
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
    const cancel = el("span", "edit dim", t("web.settings.cancel"));
    cancel.addEventListener("click", () => {
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
          const use = el("span", "edit", t("web.settings.use"));
          use.addEventListener("click", () => postConfig("model", m, true));
          r.appendChild(use);
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
        const use = el("span", "edit", t("web.settings.use"));
        use.addEventListener("click", () => postConfig("provider.active", name, true));
        line.appendChild(use);
      }
      const edit = el("span", "edit", t("web.settings.edit"));
      edit.addEventListener("click", () => {
        state.providerForm = { mode: "edit", entry };
        renderModelPanel();
      });
      line.appendChild(edit);
      if (name !== activeName) {
        const del = el("span", "edit", t("web.settings.delete"));
        del.addEventListener("click", async () => {
          const r = await api("/api/providers/" + encodeURIComponent(name), { method: "DELETE" });
          if (r.ok && r.data && r.data.ok) {
            setIndicator(t("web.settings.saved"));
            await loadProviders();
            await loadConfig();
          } else {
            const err = (r.data && r.data.error) || t("web.settings.delete_failed");
            setIndicator(err === "active-provider" ? t("web.settings.provider_active_guard") : String(err), true);
          }
        });
        line.appendChild(del);
      }
      provList.appendChild(line);
    });
    container.appendChild(provList);

    const addBtn = el("span", "edit add-provider", t("web.settings.add_provider"));
    addBtn.addEventListener("click", () => {
      state.providerForm = { mode: "add", entry: null };
      renderModelPanel();
    });
    container.appendChild(addBtn);
    if (state.providerForm) container.appendChild(providerForm());
  }

  function renderUiPanel() {
    const container = document.querySelector('[data-panel="ui"]');
    if (!container) return;
    container.textContent = "";
    const seg = el("span", "seg");
    ["dark", "light", "auto"].forEach((t) => {
      const b = el("button", currentTheme() === t ? "on" : "", t);
      b.addEventListener("click", () => {
        seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        applyTheme(t);
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
    MEMORY_CATEGORIES.forEach((c) => catSel.appendChild(el("option", "", c)));
    catSel.value = "facts";
    addRow.appendChild(catSel);
    const textIn = el("input");
    textIn.placeholder = t("web.settings.new_memory");
    addRow.appendChild(textIn);
    const addBtn = el("span", "edit", t("web.settings.add"));
    addBtn.addEventListener("click", async () => {
      const text = textIn.value.trim();
      if (!text) return;
      const r = await api("/api/memory", { method: "POST", body: { category: catSel.value, text } });
      if (r.ok && r.data && r.data.ok) {
        textIn.value = "";
        await loadMemory();
      } else {
        setIndicator(t("web.settings.add_failed"), true);
      }
    });
    addRow.appendChild(addBtn);
    container.appendChild(addRow);

    const search = el("input", "searchbox");
    search.placeholder = t("web.settings.search_memory");
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
      if (onForget) {
        const del = el("span", "mem-del", t("web.settings.forget"));
        del.addEventListener("click", onForget);
        block.appendChild(del);
      }
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
      const toggle = el("span", "toggle" + (on ? " on" : ""));
      toggle.title = on ? t("web.settings.mcp_disable") : t("web.settings.mcp_enable");
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
    const setText = (id, text) => {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    };
    setText("planHeaderLabel", t("web.sidebar.plan"));
    setText("usageHeaderLabel", t("web.sidebar.session") + " · " + t("web.sidebar.usage"));
    setText("settingsTitle", t("web.settings.title"));
    setText("closeSettings", "✕ " + t("web.topbar.close"));
    setText("sessActiveHeader", t("web.sessions.active"));
    setText("sessRecentHeader", t("web.sessions.recent"));
    setText("sessNew", t("web.sessions.new"));
    setText("sessRefresh", t("web.sessions.refresh"));
    setText("hintEnter", t("web.input.enter"));
    setText("hintShift", t("web.input.shift_enter"));
    setText("hintEsc", t("web.input.esc"));
    setText("hintAttach", t("web.input.attach"));

    const titles = {
      newChat: t("web.topbar.new_chat"),
      sessBtn: t("web.topbar.all_sessions"),
      openSettings: t("web.topbar.settings"),
      attachBtn: t("web.attach.title"),
    };
    Object.keys(titles).forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.title = titles[id];
    });
    if (inp) inp.placeholder = t("web.input.placeholder");

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
  document.getElementById("openSettings").addEventListener("click", () => {
    overlay.classList.add("open");
    void loadMemory();
    void loadSkills();
    void loadPlugins();
  });
  document.getElementById("closeSettings").addEventListener("click", () => overlay.classList.remove("open"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) overlay.classList.remove("open");
  });
  document.querySelectorAll("#setMenu .mi").forEach((mi) => {
    mi.addEventListener("click", () => {
      document.querySelectorAll("#setMenu .mi").forEach((x) => x.classList.remove("on"));
      document.querySelectorAll(".content-col .panel").forEach((x) => x.classList.remove("on"));
      mi.classList.add("on");
      const panel = document.getElementById("p-" + mi.dataset.p);
      if (panel) panel.classList.add("on");
    });
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
