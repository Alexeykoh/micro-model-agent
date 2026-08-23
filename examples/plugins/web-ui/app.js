/* web-ui frontend: SSE client + chat rendering + composer.
 * Vanilla JS, no dependencies. Served verbatim by the plugin server. */
"use strict";

const $ = (id) => document.getElementById(id);
const messages = $("messages");
const input = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const thumbsEl = $("thumbs");
const fileInput = $("file-input");

const state = {
  busy: false,
  pendingImages: [], // data URLs
  currentAssistant: null, // streaming text node
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
  let out = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  out = escapeHtml(out);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return out;
}

function scrollDown() {
  messages.scrollTop = messages.scrollHeight;
}

function addMessage(role, html, cls) {
  const div = document.createElement("div");
  div.className = "msg " + (cls || role);
  if (role !== "meta") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = role === "user" ? "You:" : "Agent:";
    div.appendChild(who);
  }
  const body = document.createElement("span");
  body.className = "text";
  body.innerHTML = html;
  div.appendChild(body);
  messages.appendChild(div);
  scrollDown();
  return body;
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
    setTimeout(connect, Math.min(reconnectDelay *= 2, 15000));
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
  es.addEventListener("phase", (e) => {
    const d = JSON.parse(e.data);
    if (d.phase === "thinking" && !state.busy) setBusy(true);
    markThinking(d.phase === "thinking");
  });
  es.addEventListener("llm_start", () => setStatus("thinking…"));
  es.addEventListener("llm_end", (e) => {
    const d = JSON.parse(e.data);
    setStatus(`llm ${d.kind || ""} ${(d.durationMs / 1000).toFixed(1)}s`);
  });
  es.addEventListener("context", (e) => {
    const d = JSON.parse(e.data);
    $("ctx").textContent = `${d.tokens} tok · q${Math.round(d.quality)}%`;
  });
  es.addEventListener("text", (e) => {
    const d = JSON.parse(e.data);
    streamText(d.text);
  });
  es.addEventListener("meta", (e) => {
    const d = JSON.parse(e.data);
    addMessage("meta", renderInline(d.text.trim()), "meta-msg");
  });
  es.addEventListener("tool_start", (e) => {
    const d = JSON.parse(e.data);
    openToolCard(d);
  });
  es.addEventListener("tool_end", (e) => {
    const d = JSON.parse(e.data);
    closeToolCard(d);
  });
  es.addEventListener("error", (e) => {
    const d = JSON.parse(e.data);
    addMessage("meta", `⚠ ${renderInline(d.message)}`, "meta-msg");
  });
  es.addEventListener("plans", (e) => renderPlan(JSON.parse(e.data)));
  es.addEventListener("turn_end", (e) => {
    const d = JSON.parse(e.data);
    finalizeAssistant();
    markThinking(false);
    setBusy(false);
    setStatus(d.success ? `done in ${(d.durationMs / 1000).toFixed(1)}s` : `failed${d.error ? ": " + d.error : ""}`);
  });
}

/* ---------------- rendering ---------------- */

function streamText(text) {
  if (!text) return;
  if (!state.currentAssistant) {
    state.currentAssistant = { node: addMessage("assistant", ""), raw: "" };
    markThinking(false);
  }
  state.currentAssistant.raw += text;
  state.currentAssistant.node.innerHTML = renderInline(state.currentAssistant.raw);
  scrollDown();
}

function finalizeAssistant() {
  state.currentAssistant = null;
}

function markThinking(on) {
  const last = messages.lastElementChild;
  if (!last) return;
  if (on) last.classList.add("thinking");
  else last.classList.remove("thinking");
}

function openToolCard(d) {
  finalizeAssistant();
  const det = document.createElement("details");
  det.className = "tool";
  det.dataset.callId = d.toolCallId || "";
  const sum = document.createElement("summary");
  sum.innerHTML =
    `<span class="tname">${escapeHtml(d.name)}</span> ` +
    `<span>${escapeHtml(d.summary || "")}</span>` +
    `<span class="duration">running…</span>`;
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "tool-body";
  if (d.args) {
    const argsPre = document.createElement("pre");
    argsPre.innerHTML = `<span class="label">args</span>\n${escapeHtml(d.args)}`;
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
    `${d.success ? "✓" : "✗"} ${(d.durationMs / 1000).toFixed(1)}s`;
  if (d.output) {
    const outPre = document.createElement("pre");
    outPre.innerHTML = `<span class="label">output</span>\n${escapeHtml(d.output)}`;
    det.querySelector(".tool-body").appendChild(outPre);
  }
  state.toolCards.delete(d.toolCallId);
  scrollDown();
}

function renderPlan(d) {
  const el = $("plan");
  const p = d.active;
  if (!p || !Array.isArray(p.steps)) {
    el.textContent = "No active plan.";
    return;
  }
  let firstPending = true;
  let html = `<div class="plan-title">${escapeHtml(p.title || "Untitled plan")}</div>`;
  for (const s of p.steps) {
    let mark, cls;
    switch (s.status) {
      case "done": mark = "✓"; cls = "mark-done"; break;
      case "failed": mark = "✗"; cls = "mark-failed"; break;
      case "skipped": mark = "−"; cls = "mark-skipped"; break;
      default:
        mark = firstPending ? "▶" : "○";
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
  sendBtn.disabled = busy;
  stopBtn.classList.toggle("hidden", !busy);
  $("status").className = "statusline " + (busy ? "busy" : "idle");
  if (!busy) setStatus("idle");
}

/* ---------------- images ---------------- */

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
    btn.title = "Remove";
    btn.onclick = () => {
      state.pendingImages.splice(i, 1);
      renderThumbs();
    };
    wrap.append(img, btn);
    thumbsEl.appendChild(wrap);
  });
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
      addMessage("user", html);
      input.value = "";
      state.pendingImages = [];
      renderThumbs();
      setBusy(true);
    } else if (res.status === 409) {
      setBusy(true); // terminal started a turn meanwhile — just reflect it
    } else {
      const body = await res.json().catch(() => ({}));
      addMessage("meta", `⚠ ${body.error || res.statusText}`, "meta-msg");
    }
  } catch (err) {
    addMessage("meta", `⚠ network error: ${err}`, "meta-msg");
  }
}

sendBtn.onclick = sendMessage;
stopBtn.onclick = async () => {
  try {
    await fetch("/api/interrupt", { method: "POST" });
  } catch { /* ignore */ }
};
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

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
    for (const m of (d.history || [])) {
      if (m.role === "assistant" || m.role === "user") {
        addMessage(m.role, renderInline(m.text));
      }
    }
    setBusy(!!d.busy);
  } catch { /* server not ready yet; SSE will drive updates */ }
}

connect();
loadState();
