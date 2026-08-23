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
};

/* ---------------- utilities ---------------- */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** Escape-first minimal markdown: fenced code, inline code, bold, links. */
function renderInline(text) {
  const blocks = [];
  let out = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
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
  es.addEventListener("plans", (e) => renderPlan(JSON.parse(e.data)));
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

/* ---------------- rendering ---------------- */

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
  if (d.args) {
    const argsPre = document.createElement("pre");
    argsPre.innerHTML = `<div class="label">args</div><code>${escapeHtml(d.args)}</code>`;
    body.appendChild(argsPre);
  }
  det.appendChild(body);
  messages.appendChild(det);
  state.toolCards.set(det.dataset.callId, det);
  scrollDown();
}

function closeToolCard(d) {
  const det = state.toolCards.get(d.toolCallId || "");
  if (!det) return;
  det.classList.add(d.success ? "ok" : "err");
  det.querySelector(".duration").textContent =
    `${d.success ? "✓" : "✗"} ${((d.durationMs || 0) / 1000).toFixed(1)}s`;
  if (d.output) {
    const body = det.querySelector(".tool-body");
    const outPre = document.createElement("pre");
    outPre.innerHTML = `<div class="label">output</div><code>${escapeHtml(d.output)}</code>`;
    body.appendChild(outPre);
    // Auto-open the card on failure so the error is visible immediately.
    if (!d.success) det.open = true;
  }
  state.toolCards.delete(d.toolCallId);
  scrollDown();
}

function renderPlan(d) {
  const el = $("plan");
  const p = d.active;
  if (!p || !Array.isArray(p.steps)) {
    el.textContent = "No active plan.";
    el.className = "plan-empty";
    return;
  }
  el.className = "";
  let firstPending = true;
  let html = `<div class="plan-title">${escapeHtml(p.title || "Untitled plan")}</div>`;
  for (const s of p.steps) {
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
  el.innerHTML = html;
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

async function sendMessage() {
  const text = input.value.trim();
  if ((!text && state.pendingImages.length === 0) || state.busy) return;
  try {
    const res = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text || "(images)", images: state.pendingImages }),
    });
    if (res.status === 202) {
      // Echo the outgoing message locally (server streams only the agent side).
      let html = escapeHtml(text);
      if (state.pendingImages.length) {
        html +=
          `<div class="imgline">` +
          state.pendingImages.map((u) => `<img src="${u}" alt="">`).join("") +
          `</div>`;
      }
      addUserMessage(html);
      input.value = "";
      input.style.height = "auto";
      state.pendingImages = [];
      renderThumbs();
      setBusy(true);
      setTyping(true); // feedback until the first llm_start/text arrives
    } else if (res.status === 409) {
      setBusy(true); // terminal started a turn meanwhile — just reflect it
    } else {
      const body = await res.json().catch(() => ({}));
      addSystemLine(`⚠ ${body.error || res.statusText}`);
    }
  } catch (err) {
    addSystemLine(`⚠ network error: ${escapeHtml(String(err))}`);
  }
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
    if (d.plan) renderPlan({ active: d.plan });
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
