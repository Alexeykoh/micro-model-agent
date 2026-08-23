/* MMA web-ui frontend — ChatGPT/DeepSeek-style chat.
 * Vanilla JS, no dependencies. Served verbatim by the plugin server.
 * Downstream: SSE (/events). Upstream: POST /api/message + /api/interrupt. */
"use strict";

const $ = (id) => document.getElementById(id);
const messages = $("messages");
const scroller = $("scroller");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const thumbsEl = $("thumbs");
const fileInput = $("file-input");

const state = {
  busy: false,
  pendingImages: [], // data URLs
  currentAssistant: null, // { node } streaming content span
  typingEl: null,
  toolCards: new Map(), // toolCallId -> details element
  plans: { active: null, drafts: [], archived: [] },
};

/* ---------------- utilities ---------------- */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/* ---------------- syntax highlighting ---------------- */

/** Lightweight regex-based highlighter. Produces <span class="tok-*"> tokens. */
function highlightCode(code, lang) {
  if (!lang) return escapeHtml(code);
  const l = lang.toLowerCase();
  const rules = {
    ts: [
      [/(\/\/.*$)/gm, "tok-cm"],
      [/(\/\*[\s\S]*?\*\/)/g, "tok-cm"],
      [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, "tok-str"],
      [/\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|this|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|void|delete|yield|type|interface|enum|abstract|implements|readonly|private|public|protected|static|as|is|keyof|infer|satisfies|never|unknown|any)\b/g, "tok-kw"],
      [/\b(true|false|null|undefined|NaN|Infinity)\b/g, "tok-num"],
      [/\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, "tok-num"],
      [/(\w+)(?=\s*\()/g, "tok-fn"],
      [/[=!<>]=?=?|&&|\|\||[+\-*/%]=?|\?\?|\.\.\./g, "tok-op"],
    ],
    js: null, // will use ts rules
    jsx: null, tsx: null, mjs: null, cjs: null,
    py: [
      [/(#.*$)/gm, "tok-cm"],
      [/("""[\s\S]*?"""|'''[\s\S]*?''')/g, "tok-cm"],
      [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, "tok-str"],
      [/\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|and|or|not|is|in|True|False|None|self|print|async|await|global|nonlocal|del|assert)\b/g, "tok-kw"],
      [/\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, "tok-num"],
      [/(\w+)(?=\s*\()/g, "tok-fn"],
    ],
    sh: [
      [/(#.*$)/gm, "tok-cm"],
      [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, "tok-str"],
      [/\b(if|then|else|elif|fi|for|do|done|while|case|esac|function|return|exit|local|export|source|sudo|apt|npm|bun|yarn|pip|git|docker|curl|wget|chmod|mkdir|rm|cp|mv|ls|cat|grep|sed|awk|find|xargs|echo|test)\b/g, "tok-kw"],
      [/\b(\d+)\b/g, "tok-num"],
      [/\$\{?\w+\}?/g, "tok-fn"],
    ],
    html: [
      [/(<!--[\s\S]*?-->)/g, "tok-cm"],
      [/(<\/?[\w-]+)/g, "tok-tag"],
      [/(\s[\w-]+)(?==)/g, "tok-attr"],
      [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, "tok-str"],
    ],
    css: [
      [/(\/\*[\s\S]*?\*\/)/g, "tok-cm"],
      [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, "tok-str"],
      [/(\.[\w-]+)/g, "tok-fn"],
      [/#[\w-]+/g, "tok-type"],
      [/\b(color|background|display|margin|padding|border|font|width|height|position|flex|grid|opacity|transition|transform|overflow)\b/g, "tok-kw"],
      [/\b(\d+(?:px|rem|em|%|vh|vw)?)\b/g, "tok-num"],
    ],
    json: [
      [/("(?:[^"\\]|\\.)*")\s*:/g, "tok-attr"],
      [/("(?:[^"\\]|\\.)*")/g, "tok-str"],
      [/\b(true|false|null)\b/g, "tok-kw"],
      [/\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g, "tok-num"],
    ],
    go: [
      [/(\/\/.*$)/gm, "tok-cm"],
      [/(\/\*[\s\S]*?\*\/)/g, "tok-cm"],
      [/("(?:[^"\\]|\\.)*"|`[^`]*`)/g, "tok-str"],
      [/\b(func|package|import|return|if|else|for|range|switch|case|default|var|const|type|struct|interface|map|chan|go|defer|select|break|continue|nil|true|false|make|new|append|len|cap|error|string|int|bool|float64|byte)\b/g, "tok-kw"],
      [/\b(\d+(?:\.\d+)?)\b/g, "tok-num"],
    ],
    rs: [
      [/\/\/.*$/gm, "tok-cm"],
      [/\/\*[\s\S]*?\*\//g, "tok-cm"],
      [/(b?"(?:[^"\\]|\\.)*")/g, "tok-str"],
      [/\b(fn|let|mut|const|return|if|else|match|for|while|loop|break|continue|struct|enum|impl|trait|pub|use|mod|crate|self|super|where|as|move|async|await|type|true|false|i32|u32|i64|u64|f32|f64|bool|String|Vec|Option|Result|Box|Rc|Arc)\b/g, "tok-kw"],
      [/\b(\d+(?:\.\d+)?)\b/g, "tok-num"],
    ],
    java: [
      [/(\/\/.*$)/gm, "tok-cm"],
      [/(\/\*[\s\S]*?\*\/)/g, "tok-cm"],
      [/("(?:[^"\\]|\\.)*")/g, "tok-str"],
      [/\b(public|private|protected|class|interface|extends|implements|return|if|else|for|while|switch|case|break|continue|new|this|super|static|final|void|int|long|double|float|boolean|char|String|try|catch|finally|throw|import|package|abstract|synchronized)\b/g, "tok-kw"],
      [/\b(true|false|null)\b/g, "tok-num"],
      [/\b(\d+(?:\.\d+)?)\b/g, "tok-num"],
    ],
    rb: [
      [/#.*$/gm, "tok-cm"],
      [/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, "tok-str"],
      [/\b(def|class|module|return|if|elsif|else|unless|for|while|do|end|begin|rescue|raise|require|include|extend|attr|lambda|proc|yield|self|true|false|nil|puts|print|gets)\b/g, "tok-kw"],
      [/\b(\d+(?:\.\d+)?)\b/g, "tok-num"],
    ],
    md: [
      [/^(#{1,6}\s.*)$/gm, "tok-kw"],
      [/(```[\s\S]*?```)/g, "tok-str"],
      [/`([^`]+)`/g, "tok-str"],
      [/\*\*([^*]+)\*\*/g, "tok-op"],
      [/^(\s*[-*+]\s)/gm, "tok-op"],
      [/^(\s*\d+\.\s)/gm, "tok-op"],
    ],
    graphql: [
      [/(#.*$)/gm, "tok-cm"],
      [/\b(query|mutation|subscription|fragment|on|type|input|enum|interface|union|scalar|schema|extend|directive|repeatable| implements| @)\b/g, "tok-kw"],
      [/("(?:[^"\\]|\\.)*")/g, "tok-str"],
      [/(\w+)(?=\s*[({:])/g, "tok-fn"],
      [/\b(\d+)\b/g, "tok-num"],
    ],
    sql: [
      [/(--.*$)/gm, "tok-cm"],
      [/(\/\*[\s\S]*?\*\/)/g, "tok-cm"],
      [/('(?:[^'\\]|\\.)*')/g, "tok-str"],
      [/\b(SELECT|FROM|WHERE|INSERT|INTO|UPDATE|SET|DELETE|CREATE|ALTER|DROP|TABLE|INDEX|VIEW|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|IS|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|AUTO_INCREMENT|INT|VARCHAR|TEXT|BOOLEAN|DATE|TIMESTAMP|INTEGER)\b/gi, "tok-kw"],
      [/\b(\d+(?:\.\d+)?)\b/g, "tok-num"],
    ],
  };
  // Aliases
  rules.js = rules.ts;
  rules.jsx = rules.ts;
  rules.tsx = rules.ts;
  rules.mjs = rules.ts;
  rules.cjs = rules.ts;
  rules.yaml = rules.json;
  rules.yml = rules.json;
  rules.toml = rules.json;
  rules.lock = null;
  rules.txt = null;

  const r = rules[l] ?? rules[l.split(".").pop()];
  if (!r) return escapeHtml(code);

  // Tokenize: apply rules sequentially, collecting spans
  const spans = [];
  for (const [re, cls] of r) {
    // For JSON attr rule that builds HTML directly
    if (typeof cls === "undefined") continue;
    let m;
    const rx = new RegExp(re.source, re.flags);
    while ((m = rx.exec(code)) !== null) {
      spans.push({ i: m.index, j: m.index + m[0].length, cls, text: m[0] });
    }
  }
  // Sort by start, then longer match first
  spans.sort((a, b) => a.i - b.i || b.j - a.j);

  // Merge non-overlapping spans
  const merged = [];
  let lastEnd = 0;
  for (const s of spans) {
    if (s.i >= lastEnd) {
      merged.push(s);
      lastEnd = s.j;
    }
  }

  // Build output
  let out = "";
  let pos = 0;
  for (const s of merged) {
    if (s.i > pos) out += escapeHtml(code.slice(pos, s.i));
    out += `<span class="${s.cls}">${escapeHtml(s.text)}</span>`;
    pos = s.j;
  }
  if (pos < code.length) out += escapeHtml(code.slice(pos));
  return out;
}

/** Escape-first minimal markdown: fenced code, inline code, bold, links, autolinks, file chips. */
function renderInline(text) {
  const blocks = [];
  // 1. Fenced code blocks — with syntax highlighting
  let out = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const highlighted = highlightCode(code, lang);
    blocks.push(`<pre><code class="lang-${lang || "text"}">${highlighted}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  // 2. Escape HTML
  out = escapeHtml(out);
  // 3. Inline code
  const inlineCodes = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlineCodes.push(`<code>${code}</code>`);
    return `\u0001${inlineCodes.length - 1}\u0001`;
  });
  // 4. Bold
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  // 5. Markdown links
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 6. Autolink bare URLs (not already inside an href)
  out = out.replace(/(?<![href=">])((?:https?:\/\/)[^\s<>"')\]])+/g, '<a class="tool-url-chip" href="$1" target="_blank" rel="noopener">$1</a>');
  // 7. File path chips (relative paths with known extensions, not inside tags)
  out = out.replace(/(?<!=["'])((?:[A-Za-z0-9_.\-~]\/)*[A-Za-z0-9_.\-~]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|html|yaml|yml|toml|lock|go|rs|java|rb|sh|ps1|sln|csproj|graphql|sql|txt|cfg|ini))\b/g, '<span class="tool-file-chip">$1</span>');
  // 8. Restore inline code placeholders
  out = out.replace(/\u0001(\d+)\u0001/g, (_m, i) => inlineCodes[Number(i)]);
  // 9. Restore fenced code blocks
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return `<p>${out.replace(/\n{2,}/g, "</p><p>")}</p>`;
}

function scrollDown() {
  scroller.scrollTop = scroller.scrollHeight;
}

function addUserMessage(html) {
  const div = document.createElement("div");
  div.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = html;
  div.appendChild(bubble);
  messages.appendChild(div);
  scrollDown();
}

function addAssistantMessage() {
  const div = document.createElement("div");
  div.className = "msg assistant";
  const av = document.createElement("div");
  av.className = "avatar";
  av.textContent = "M";
  const content = document.createElement("div");
  content.className = "content text";
  div.append(av, content);
  messages.appendChild(div);
  scrollDown();
  return content;
}

function addSystemLine(html) {
  const div = document.createElement("div");
  div.className = "msg system-line";
  div.innerHTML = html;
  messages.appendChild(div);
  scrollDown();
}

/* ---------------- typing indicator ---------------- */

function setTyping(on) {
  if (on && !state.typingEl && !state.currentAssistant) {
    const row = document.createElement("div");
    row.className = "msg assistant";
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = "M";
    const dots = document.createElement("div");
    dots.className = "typing-dots";
    dots.innerHTML = "<i></i><i></i><i></i>";
    row.append(av, dots);
    messages.appendChild(row);
    state.typingEl = row;
    scrollDown();
  } else if (!on && state.typingEl) {
    state.typingEl.remove();
    state.typingEl = null;
  }
}

/* ---------------- SSE ---------------- */

let es = null;
let reconnectDelay = 1000;

function connect() {
  es = new EventSource("/events");
  es.onopen = () => {
    $("conn").className = "conn conn-on";
    reconnectDelay = 1000;
  };
  es.onerror = () => {
    $("conn").className = "conn conn-off";
    es.close();
    setTimeout(connect, Math.min((reconnectDelay *= 2), 15000));
  };
  es.addEventListener("session", (e) => {
    const d = JSON.parse(e.data);
    if (d.session) {
      $("session-name").textContent = d.session.name || "";
      $("model").textContent = d.session.model || "";
    }
    setBusy(!!d.busy);
  });
  es.addEventListener("state", (e) => setBusy(JSON.parse(e.data).busy === true));
  es.addEventListener("phase", () => {});
  es.addEventListener("llm_start", () => {
    setTyping(true);
    setStatus("thinking…");
  });
  es.addEventListener("llm_end", (e) => {
    const d = JSON.parse(e.data);
    setStatus(`llm ${d.kind || ""} · ${(d.durationMs / 1000).toFixed(1)}s`);
    $("logmeta").textContent =
      `last call: ${d.kind || "?"}${d.callCount ? ` · ${d.callCount} tool call(s)` : ""}` +
      `${d.durationMs ? ` · ${(d.durationMs / 1000).toFixed(1)}s` : ""}`;
  });
  es.addEventListener("context", (e) => {
    const d = JSON.parse(e.data);
    $("ctx").textContent = `${d.tokens} tok`;
  });
  es.addEventListener("text", (e) => {
    const d = JSON.parse(e.data);
    streamText(d.text);
  });
  es.addEventListener("meta", (e) => {
    const d = JSON.parse(e.data);
    const t = (d.text || "").trim();
    if (!t) return;
    setTyping(false);
    addSystemLine(renderInline(t));
  });
  es.addEventListener("tool_start", (e) => {
    const d = JSON.parse(e.data);
    setTyping(false);
    openToolCard(d);
  });
  es.addEventListener("tool_end", (e) => closeToolCard(JSON.parse(e.data)));
  es.addEventListener("error", (e) => {
    const d = JSON.parse(e.data);
    setTyping(false);
    addSystemLine(`⚠ ${renderInline(d.message)}`);
  });
  es.addEventListener("plans", (e) => {
    const d = JSON.parse(e.data);
    state.plans = { active: d.active, drafts: d.drafts || [], archived: d.archived || [] };
    renderPlans();
  });
  es.addEventListener("turn_end", (e) => {
    const d = JSON.parse(e.data);
    finalizeAssistant();
    setTyping(false);
    setBusy(false);
    setStatus(
      d.success
        ? `done in ${((d.durationMs || 0) / 1000).toFixed(1)}s`
        : `failed${d.error ? ": " + d.error : ""}`,
    );
  });
}

/* ---------------- plan browser ---------------- */

function planStepsHtml(p) {
  let firstPending = true;
  let html = "";
  for (const s of p.steps || []) {
    let mark, cls;
    switch (s.status) {
      case "done": mark = "✓"; cls = "mark-done"; break;
      case "failed": mark = "✗"; cls = "mark-failed"; break;
      case "skipped": mark = "−"; cls = "mark-skipped"; break;
      default:
        mark = firstPending ? "●" : "○";
        cls = firstPending ? "mark-current" : "";
        firstPending = false;
    }
    html += `<div class="plan-step"><span class="${cls}">${mark}</span> ${escapeHtml(s.description)}</div>`;
    for (const st of s.subtasks || []) {
      html += `<div class="plan-sub">${st.done ? "✓" : "○"} ${escapeHtml(st.text)}</div>`;
    }
  }
  return html;
}

function planProgress(p) {
  const steps = p.steps || [];
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done, total: steps.length };
}

function planCardHtml(p, kind) {
  const { done, total } = planProgress(p);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const title = p.title || p.name || "Untitled plan";
  const btn =
    kind === "archived" || !total
      ? ""
      : `<button class="plan-btn" data-plan-id="${escapeHtml(p.id || "")}" data-kind="${kind}" ${
          state.busy ? "disabled" : ""
        }>${kind === "active" ? "Продолжить" : "Приступить"}</button>`;
  return (
    `<details class="plan-card kind-${kind}"${kind === "active" ? " open" : ""}>` +
    `<summary>` +
    `<span class="plan-card-title">${escapeHtml(title)}</span>` +
    `<span class="plan-progress">${done}/${total}</span>` +
    `</summary>` +
    `<div class="plan-bar"><i style="width:${pct}%"></i></div>` +
    `<div class="plan-steps">${planStepsHtml(p) || '<div class="plan-empty">Нет шагов.</div>'}</div>` +
    btn +
    `</details>`
  );
}

function renderPlans() {
  const el = $("plan");
  const { active, drafts, archived } = state.plans;
  let html = "";
  html += `<div class="plan-group-label">Активный</div>`;
  html += active
    ? planCardHtml(active, "active")
    : `<div class="plan-empty">Нет активного плана.</div>`;
  if (drafts.length) {
    html += `<div class="plan-group-label">Черновики (${drafts.length})</div>`;
    html += drafts.map((p) => planCardHtml(p, "draft")).join("");
  }
  if (archived.length) {
    html += `<div class="plan-group-label">Архив (${archived.length})</div>`;
    html += archived.map((p) => planCardHtml(p, "archived")).join("");
  }
  el.innerHTML = html;
  el.className = "";
}

/** Prompt sent to the agent when a plan button is pressed. */
function planContinuePrompt(p, kind) {
  const title = p.title || p.name || "Untitled plan";
  if (kind === "active") {
    return (
      `Продолжай работу по активному плану «${title}». ` +
      `Работай по первому незавершённому шагу, план не пересоздавай.`
    );
  }
  return (
    `Переключись на сохранённый план id=${p.id || ""} «${title}» ` +
    `(tool plan, action=switch), затем продолжи его выполнение ` +
    `с первого незавершённого шага.`
  );
}

async function continuePlan(btn) {
  const { planId, kind } = btn.dataset;
  const pool =
    kind === "active"
      ? [state.plans.active]
      : [...state.plans.drafts, ...state.plans.archived];
  const plan = pool.find((p) => p && (p.id || "") === planId);
  if (!plan || state.busy) return;
  await submitText(planContinuePrompt(plan, kind));
}

$("plan").addEventListener("click", (e) => {
  const btn = e.target.closest("button.plan-btn");
  if (btn && !btn.disabled) continuePlan(btn);
});

function streamText(text) {
  if (!text) return;
  setTyping(false);
  if (!state.currentAssistant) {
    state.currentAssistant = { node: addAssistantMessage(), raw: "" };
  }
  state.currentAssistant.raw += text;
  state.currentAssistant.node.innerHTML = renderInline(state.currentAssistant.raw);
  scrollDown();
}

function finalizeAssistant() {
  state.currentAssistant = null;
}

function openToolCard(d) {
  finalizeAssistant();
  const det = document.createElement("details");
  det.className = "tool";
  det.dataset.callId = d.toolCallId || "";
  const sum = document.createElement("summary");
  sum.innerHTML =
    `<span class="tname">${escapeHtml(d.name)}</span>` +
    `<span class="tsummary">${escapeHtml(d.summary || "")}</span>` +
    `<span class="duration">running…</span>`;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "tool-body";

  // Build tabs container
  const tabs = document.createElement("div");
  tabs.className = "tool-tabs";

  // Always create args tab + panel
  if (d.args) {
    const btn = document.createElement("button");
    btn.className = "tool-tab active";
    btn.textContent = "args";
    btn.dataset.tab = "args";
    tabs.appendChild(btn);

    const panel = document.createElement("div");
    panel.className = "tool-tab-panel active";
    panel.dataset.tab = "args";
    panel.textContent = d.args;
    body.appendChild(tabs);
    body.appendChild(panel);
  }

  det.appendChild(body);
  messages.appendChild(det);
  state.toolCards.set(det.dataset.callId, det);
  scrollDown();
}

/* ---------------- tool output helpers ---------------- */

/** Detect if a string is likely raw HTML (page dump from bash curl, browser, etc.) */
function looksLikeHtml(s) {
  if (!s) return false;
  const head = s.slice(0, 2000);
  if (/^\s*<!doctype\s+html/i.test(head)) return true;
  if (/<html[\s>]/i.test(head)) return true;
  // tag-soup heuristic: many closing tags in the head
  const closeTags = head.match(/<\/\w+>/g);
  return closeTags && closeTags.length > 30;
}

/** Extract readable text from raw HTML: strip scripts/styles/comments, tags, decode entities. */
function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article|header|footer|nav|main)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  const ents = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", mdash: "—", ndash: "–", deg: "°" };
  s = s.replace(/&(\w+);/g, (_m, e) => ents[e] || _m);
  s = s.replace(/&#(\d+);/g, (_m, c) => String.fromCharCode(Number(c)));
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]+/g, " ");
  return s.trim();
}

/** Extract <title> from an HTML page. */
function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
}

/** Per-tool preview caps (chars). */
const TOOL_PREVIEW = {
  browser: 1200,
  web_search: 1000,
  web_fetch: 800,
  web_browse: 800,
  bash: 1200,
  read_file: 600,
  list_dir: 600,
  grep: 800,
  glob: 400,
};
const GENERIC_CAP = 600;

/**
 * Build the output content element for a tool card.
 * Returns a DOM element with text/summary/full structure.
 */
function buildToolOutput(output, toolName, success) {
  if (!output) return null;

  const isHtml = looksLikeHtml(output);
  let text = isHtml ? htmlToText(output) : output;
  const title = isHtml ? htmlTitle(output) : null;

  // Prepend title hint for HTML pages
  let header = "";
  if (title) {
    header = `📄 ${title}\n`;
    text = header + text;
  }

  const cap = TOOL_PREVIEW[toolName] ?? GENERIC_CAP;
  const needsCollapse = text.length > cap;

  const wrap = document.createElement("div");
  wrap.className = "tool-out";

  if (!needsCollapse) {
    const block = document.createElement("div");
    block.className = "tool-out-full";
    block.textContent = text;
    wrap.appendChild(block);
    return wrap;
  }

  // Collapsible: summary + hidden full
  const summary = document.createElement("div");
  summary.className = "tool-out-summary faded";
  summary.textContent = text.slice(0, cap);
  wrap.appendChild(summary);

  const full = document.createElement("div");
  full.className = "tool-out-full";
  full.textContent = text;
  full.style.display = "none";
  wrap.appendChild(full);

  const btn = document.createElement("button");
  btn.className = "tool-more-link";
  btn.textContent = `▸ показать весь вывод (${text.length.toLocaleString()} символов)`;
  let expanded = false;
  btn.onclick = (e) => {
    e.preventDefault();
    expanded = !expanded;
    summary.style.display = expanded ? "none" : "";
    full.style.display = expanded ? "" : "none";
    btn.textContent = expanded
      ? `▾ свернуть (${cap.toLocaleString()} / ${text.length.toLocaleString()})`
      : `▸ показать весь вывод (${text.length.toLocaleString()} символов)`;
  };
  wrap.appendChild(btn);

  return wrap;
}

function closeToolCard(d) {
  const det = state.toolCards.get(d.toolCallId || "");
  if (!det) return;
  det.classList.add(d.success ? "ok" : "err");
  det.querySelector(".duration").textContent =
    `${d.success ? "✓" : "✗"} ${((d.durationMs || 0) / 1000).toFixed(1)}s`;

  const body = det.querySelector(".tool-body");
  const tabs = body.querySelector(".tool-tabs");

  if (d.output) {
    // Create or find tabs container
    if (!tabs) {
      const newTabs = document.createElement("div");
      newTabs.className = "tool-tabs";
      body.prepend(newTabs);
    }
    const tabBar = body.querySelector(".tool-tabs");

    // Add output tab button
    const outBtn = document.createElement("button");
    outBtn.className = "tool-tab";
    outBtn.textContent = "output";
    outBtn.dataset.tab = "output";
    tabBar.appendChild(outBtn);

    // Add output panel
    const outPanel = document.createElement("div");
    outPanel.className = "tool-tab-panel";
    outPanel.dataset.tab = "output";
    const outBlock = buildToolOutput(d.output, d.name, d.success);
    if (outBlock) outPanel.appendChild(outBlock);
    body.appendChild(outPanel);

    // Switch to output tab
    tabBar.querySelectorAll(".tool-tab").forEach((b) => b.classList.remove("active"));
    body.querySelectorAll(".tool-tab-panel").forEach((p) => p.classList.remove("active"));
    outBtn.classList.add("active");
    outPanel.classList.add("active");

    // Auto-open the card on failure so the error is visible immediately.
    if (!d.success) det.open = true;
  }

  // Wire up tab switching (after all tabs exist)
  const tabBarFinal = body.querySelector(".tool-tabs");
  if (tabBarFinal && !tabBarFinal._wired) {
    tabBarFinal._wired = true;
    tabBarFinal.addEventListener("click", (e) => {
      const btn = e.target.closest(".tool-tab");
      if (!btn) return;
      const name = btn.dataset.tab;
      tabBarFinal.querySelectorAll(".tool-tab").forEach((b) => b.classList.remove("active"));
      body.querySelectorAll(".tool-tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      body.querySelector(`.tool-tab-panel[data-tab="${name}"]`)?.classList.add("active");
    });
  }

  state.toolCards.delete(d.toolCallId);
  scrollDown();
}

function setStatus(text) {
  const el = $("status");
  el.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  input.disabled = busy;
  stopBtn.classList.toggle("hidden", !busy);
  sendBtn.classList.toggle("hidden", busy);
  document.querySelectorAll("button.plan-btn").forEach((b) => (b.disabled = busy));
  if (!busy) {
    setStatus("idle");
    updateSendEnabled();
  }
  if (!busy) setTyping(false);
}

/* ---------------- composer ---------------- */

function updateSendEnabled() {
  const hasText = input.value.trim().length > 0;
  const hasImages = state.pendingImages.length > 0;
  sendBtn.disabled = !(hasText || hasImages);
}

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  updateSendEnabled();
});

async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const maxSide = 800;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.6);
}

function renderThumbs() {
  thumbsEl.innerHTML = "";
  thumbsEl.classList.toggle("has", state.pendingImages.length > 0);
  state.pendingImages.forEach((url, i) => {
    const wrap = document.createElement("span");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.src = url;
    const btn = document.createElement("button");
    btn.textContent = "×";
    btn.title = "Убрать";
    btn.onclick = () => {
      state.pendingImages.splice(i, 1);
      renderThumbs();
    };
    wrap.append(img, btn);
    thumbsEl.appendChild(wrap);
  });
  updateSendEnabled();
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    if (state.pendingImages.length >= 3) break;
    try {
      state.pendingImages.push(await downscale(f));
    } catch {
      /* skip undecodable image */
    }
  }
  renderThumbs();
}

fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("hidden");
  }),
);
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (e.relatedTarget === null) $("dropzone").classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  $("dropzone").classList.add("hidden");
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});

/* ---------------- sending ---------------- */

/** Shared submit path: composer and plan buttons both go through here. */
async function submitText(text, images) {
  if (state.busy) return false;
  try {
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, images: images || [] }),
    });
    if (res.status === 202) {
      finalizeAssistant(); // close any in-progress stream before showing the new message
      addUserMessage(renderInline(text));
      setBusy(true);
      setTyping(true); // feedback until the first llm_start/text arrives
      return true;
    }
    if (res.status === 409) {
      setBusy(true); // terminal started a turn meanwhile — just reflect it
      return false;
    }
    const body = await res.json().catch(() => ({}));
    addSystemLine(`⚠ ${body.error || res.statusText}`);
    return false;
  } catch (err) {
    addSystemLine(`⚠ network error: ${escapeHtml(String(err))}`);
    return false;
  }
}

async function sendMessage() {
  const text = input.value.trim();
  if ((!text && state.pendingImages.length === 0) || state.busy) return;
  const images = state.pendingImages;
  const ok = await submitText(text || "(images)", images);
  if (!ok) return;
  // Echo attachments locally (submitText echoes only the text).
  if (images.length) {
    const div = messages.lastElementChild;
    if (div) {
      const line = document.createElement("div");
      line.className = "imgline";
      line.innerHTML = images.map((u) => `<img src="${u}" alt="">`).join("");
      div.querySelector(".bubble").appendChild(line);
    }
  }
  input.value = "";
  input.style.height = "auto";
  state.pendingImages = [];
  renderThumbs();
}

sendBtn.onclick = sendMessage;
stopBtn.onclick = async () => {
  try {
    await fetch("/api/interrupt", { method: "POST" });
  } catch {
    /* ignore */
  }
};
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$("sb-toggle").onclick = () => {
  if (window.innerWidth <= 900) document.body.classList.toggle("side-open");
  else document.body.classList.toggle("side-collapsed");
};

/* ---------------- boot ---------------- */

async function loadState() {
  try {
    const res = await fetch("/api/state");
    const d = await res.json();
    if (d.session) {
      $("session-name").textContent = d.session.name || "";
      $("model").textContent = d.session.model || "";
    }
    state.plans = {
      active: d.plan || null,
      drafts: d.drafts || [],
      archived: d.archived || [],
    };
    renderPlans();
    for (const m of d.history || []) {
      if (m.role === "user") addUserMessage(renderInline(m.text));
      else if (m.role === "assistant") {
        const node = addAssistantMessage();
        node.innerHTML = renderInline(m.text);
      }
    }
    setBusy(!!d.busy);
    scrollDown();
  } catch {
    /* server not ready yet; SSE will drive updates */
  }
}

updateSendEnabled();
connect();
loadState();
