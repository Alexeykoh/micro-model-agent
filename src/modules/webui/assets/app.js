(() => {
  "use strict";

  const token = new URLSearchParams(location.search).get("token") || "";
  const postHeaders = { "content-type": "application/json" };
  if (token) postHeaders["x-mma-token"] = token;

  const msgs = document.getElementById("msgs");
  const emptyEl = document.getElementById("empty");
  const inp = document.getElementById("inp");
  const planEl = document.getElementById("plan");
  const usageEl = document.getElementById("usage");
  const modelEl = document.getElementById("modelName");
  const sessionEl = document.getElementById("sessionName");
  const tabstripEl = document.getElementById("tabstrip");

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

  const toolNodes = new Map();
  let curText = null;
  let curMeta = null;
  let busy = false;

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
    const keys = ["path", "file", "command", "query", "url", "pattern", "name", "id"];
    for (const key of keys) {
      if (typeof args[key] === "string" && args[key]) return args[key];
    }
    try {
      const json = JSON.stringify(args);
      return json === "{}" ? "" : json.slice(0, 120);
    } catch {
      return "";
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function nearBottom() {
    return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
  }

  function scroll() {
    if (nearBottom()) msgs.scrollTop = msgs.scrollHeight;
  }

  function append(node) {
    msgs.appendChild(node);
    scroll();
    return node;
  }

  function showEmpty(show) {
    emptyEl.style.display = show ? "" : "none";
  }

  function clearBusy() {
    const line = document.getElementById("busyline");
    if (line) line.remove();
  }

  function setBusy(next) {
    busy = !!next;
    inp.disabled = busy;
    if (!busy) clearBusy();
  }

  function onText(chunk) {
    clearBusy();
    showEmpty(false);
    curMeta = null;
    if (!curText) {
      curText = append(el("div", "ans"));
    }
    curText.textContent += chunk;
    scroll();
  }

  function onMeta(chunk) {
    showEmpty(false);
    curText = null;
    if (!curMeta) {
      curMeta = el("div", "think");
      const head = el("div", "think-h");
      head.appendChild(el("span", "g", "✦"));
      head.appendChild(el("span", "lab", "thinking"));
      head.appendChild(el("span", "tog", "▾ hide"));
      const body = el("div", "think-body");
      curMeta.appendChild(head);
      curMeta.appendChild(body);
      append(curMeta);
    }
    curMeta.querySelector(".think-body").textContent += chunk;
    scroll();
  }

  function onPhase(phase) {
    if (phase === "thinking") {
      showEmpty(false);
      if (!document.getElementById("busyline")) {
        const line = el("div", "busy");
        line.id = "busyline";
        line.appendChild(el("span", "spin", "✦"));
        line.appendChild(el("span", "lab", "thinking…"));
        append(line);
      }
    } else {
      clearBusy();
    }
  }

  function onToolStart(data) {
    clearBusy();
    showEmpty(false);
    curText = null;
    curMeta = null;
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
    append(line);
    toolNodes.set(data.toolCallId, { status });
  }

  function onToolEnd(data) {
    const node = toolNodes.get(data.toolCallId);
    if (!node) return;
    node.status.textContent = data.success ? " ✓" : " ✗";
    if (!data.success) node.status.classList.add("fail");
    if (typeof data.durationMs === "number") {
      node.status.textContent += " " + formatMs(data.durationMs);
    }
    toolNodes.delete(data.toolCallId);
  }

  function onTurnEnd(data) {
    setBusy(false);
    curText = null;
    curMeta = null;
    if (data.success === false) {
      append(el("div", data.interrupted ? "warnline" : "errline", data.interrupted ? "⚠ stopped" : "✗ turn failed"));
      return;
    }
    const parts = [];
    if (typeof data.toolCalls === "number") parts.push(data.toolCalls + " tools");
    if (typeof data.durationMs === "number") parts.push(formatMs(data.durationMs));
    if (parts.length) append(el("div", "metric", "⟡ " + parts.join(" · ")));
  }

  function formatMs(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
  }

  function renderTabs(state) {
    tabstripEl.textContent = "";
    if (!state.sessionId) return;
    const tab = el("div", "stab on");
    tab.appendChild(el("span", "name", state.sessionName || state.sessionId));
    tab.appendChild(el("span", "sid", String(state.sessionId).slice(0, 4)));
    tabstripEl.appendChild(tab);
  }

  function renderPlan(plan) {
    planEl.textContent = "";
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
      planEl.appendChild(el("div", "kv dim", "no active plan"));
      return;
    }
    const done = plan.steps.filter((s) => s.status === "done").length;
    const pct = Math.round((done / plan.steps.length) * 100);
    const bar = el("div", "plan-bar");
    const track = el("span", "pbar");
    const fill = el("i");
    fill.style.width = pct + "%";
    track.appendChild(fill);
    bar.appendChild(track);
    bar.appendChild(el("span", "pct", pct + "%"));
    planEl.appendChild(bar);
    plan.steps.forEach((step, i) => {
      const current = i === plan.currentIndex && step.status !== "done";
      const cls = "plan-step " + (step.status === "done" ? "done" : step.status === "failed" ? "fail" : current ? "cur" : "");
      const glyph = step.status === "done" ? "✓ " : step.status === "failed" ? "✗ " : current ? "▸ " : "○ ";
      planEl.appendChild(el("div", cls.trim(), glyph + step.text));
    });
  }

  function renderUsage(state) {
    usageEl.textContent = "";
    const rows = [
      ["session", state.sessionId ? String(state.sessionId).slice(0, 8) : "—"],
      ["model", state.model || "—"],
    ];
    for (const [key, value] of rows) {
      const row = el("div", "kv");
      row.appendChild(el("span", "", key));
      row.appendChild(el("b", "", value));
      usageEl.appendChild(row);
    }
  }

  function renderState(state, isBusy) {
    modelEl.textContent = state.model ? state.model + (state.provider ? " · " + state.provider : "") : "";
    sessionEl.textContent = state.sessionName || (state.sessionId ? String(state.sessionId) : "");
    renderTabs(state);
    renderPlan(state.plan);
    renderUsage(state);
    setBusy(isBusy);
  }

  async function refresh() {
    try {
      const headers = token ? { "x-mma-token": token } : {};
      const res = await fetch("/api/state", { headers });
      if (!res.ok) return;
      const data = await res.json();
      renderState(data.state || {}, !!data.busy);
    } catch {
      /* server not reachable yet */
    }
  }

  const sseUrl = "/events" + (token ? "?token=" + encodeURIComponent(token) : "");
  const es = new EventSource(sseUrl);

  es.addEventListener("text", (e) => onText(JSON.parse(e.data).chunk || ""));
  es.addEventListener("meta", (e) => onMeta(JSON.parse(e.data).chunk || ""));
  es.addEventListener("phase", (e) => onPhase(JSON.parse(e.data).phase));
  es.addEventListener("tool_start", (e) => onToolStart(JSON.parse(e.data)));
  es.addEventListener("tool_end", (e) => onToolEnd(JSON.parse(e.data)));
  es.addEventListener("turn_end", (e) => onTurnEnd(JSON.parse(e.data)));
  es.addEventListener("state", (e) => setBusy(!!JSON.parse(e.data).busy));
  es.addEventListener("error", (e) => {
    if (!e.data) return;
    try {
      const data = JSON.parse(e.data);
      if (data.error) append(el("div", "errline", "✗ " + data.error));
    } catch {
      /* ignore malformed error payload */
    }
  });

  async function send() {
    const text = inp.value.trim();
    if (!text) return;
    showEmpty(false);
    append(el("div", "u", text));
    inp.value = "";
    if (text.startsWith("/")) {
      try {
        const res = await fetch("/api/command", { method: "POST", headers: postHeaders, body: JSON.stringify({ line: text }) });
        if (!res.ok) append(el("div", "detail", "↳ command unavailable"));
      } catch {
        append(el("div", "detail", "↳ command unavailable"));
      }
      return;
    }
    curText = null;
    curMeta = null;
    clearBusy();
    try {
      const res = await fetch("/api/message", { method: "POST", headers: postHeaders, body: JSON.stringify({ text }) });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        append(el("div", "warnline", "⚠ " + String((body && body.error) || res.status)));
      }
    } catch {
      append(el("div", "errline", "✗ connection failed"));
    }
  }

  async function interrupt() {
    try {
      await fetch("/api/interrupt", { method: "POST", headers: postHeaders });
    } catch {
      /* best effort */
    }
  }

  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!busy) send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      interrupt();
    }
  });

  msgs.addEventListener("click", (e) => {
    const head = e.target.closest(".think-h");
    if (!head) return;
    const body = head.nextElementSibling;
    const hidden = body.classList.toggle("hidden");
    const tog = head.querySelector(".tog");
    if (tog) tog.textContent = hidden ? "▸ show" : "▾ hide";
  });

  document.getElementById("newChat").addEventListener("click", () => {
    msgs.querySelectorAll(".ans, .u, .think, .act, .detail, .metric, .warnline, .errline, .busy").forEach((n) => n.remove());
    curText = null;
    curMeta = null;
    showEmpty(true);
  });

  const sessDD = document.getElementById("sessDD");
  document.getElementById("sessBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    sessDD.classList.toggle("open");
  });
  document.addEventListener("click", () => sessDD.classList.remove("open"));

  document.querySelectorAll("[data-collapse]").forEach((head) => {
    head.addEventListener("click", () => {
      const body = head.nextElementSibling;
      const collapsed = body.classList.toggle("collapsed");
      head.textContent = (collapsed ? "▸ " : "▾ ") + head.textContent.slice(2);
    });
  });

  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    document.body.classList.add("light");
  }

  showEmpty(true);
  refresh();
  setInterval(refresh, 2000);
})();
