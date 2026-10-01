// Streaming Markdown for the web UI.
//
// Backed by `streaming-markdown` (smd.js, MIT, Damian Tarnawski) — an
// incremental parser that only appends to the DOM. Fenced code blocks are
// rendered with a header (language label + copy button) and highlighted once
// the fence closes (`highlight.js`, MIT), never per token.
//
// Safety: model output is untrusted. Text is always written with
// `createTextNode`; the only HTML that ever reaches the DOM is highlight.js
// output, which is parsed with `DOMParser` (inert) and imported node-by-node —
// no `innerHTML`. Link/image URLs are restricted to http(s)/mailto/data-image.

import * as smd from "./smd.js";

const COPY_ICON =
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';
const CHECK_ICON = '<path d="M20 6 9 17l-5-5"/>';

function svgIcon(inner) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "svg-icon");
  // The glyphs below are static, trusted literals (never model output).
  const doc = new DOMParser().parseFromString("<svg>" + inner + "</svg>", "image/svg+xml");
  const src = doc.documentElement;
  for (const child of Array.from(src.childNodes)) {
    svg.appendChild(document.importNode(child, true));
  }
  return svg;
}

function setBtnIcon(btn, inner) {
  btn.replaceChildren(svgIcon(inner));
}

/** Copy `text` to the clipboard. Resolves to `true` on success. */
export function copyText(text) {
  const value = String(text == null ? "" : text);
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(value).then(
      () => true,
      () => fallbackCopy(value),
    );
  }
  return Promise.resolve(fallbackCopy(value));
}

// Legacy path for non-secure origins (`mma web --host <lan-ip>`) and older
// browsers without the async Clipboard API.
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ok = document.execCommand("copy");
  } catch (err) {
    ok = false;
  }
  ta.remove();
  return ok;
}

function nodesFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.body.childNodes).map((n) => document.importNode(n, true));
}

/** Highlight `codeEl` in place. Returns `true` when highlighting was applied. */
export function highlightInto(codeEl, code, lang) {
  const hljs = window.hljs;
  if (!hljs || !code) return false;
  try {
    const html =
      lang && hljs.getLanguage(lang)
        ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
    codeEl.replaceChildren(...nodesFromHtml(html));
    codeEl.classList.add("hljs");
    return true;
  } catch (err) {
    return false;
  }
}

function safeUrl(raw, isImage) {
  if (typeof raw !== "string" || !raw) return null;
  const s = raw.trim();
  if (isImage && /^data:image\/[a-z0-9.+-]+;/i.test(s)) return s;
  try {
    const u = new URL(s, location.href);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
      return u.href;
    }
  } catch (err) {
    /* relative or malformed */
  }
  return null;
}

function makeCopyButton(opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cb-copy";
  btn.disabled = true;
  btn.setAttribute("aria-label", opts.copyLabel || "copy");
  btn.title = opts.copyLabel || "copy";
  setBtnIcon(btn, COPY_ICON);
  return btn;
}

function flashButton(btn, inner, label, ms) {
  const prevTitle = btn.title;
  setBtnIcon(btn, inner);
  if (label) {
    btn.setAttribute("aria-label", label);
    btn.title = label;
  }
  btn.classList.add("done");
  window.setTimeout(() => {
    setBtnIcon(btn, COPY_ICON);
    btn.setAttribute("aria-label", prevTitle);
    btn.title = prevTitle;
    btn.classList.remove("done");
  }, ms);
}

function wireCopy(btn, codeEl, opts) {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    copyText(codeEl.textContent).then((ok) => {
      if (ok) flashButton(btn, CHECK_ICON, opts.copiedLabel || "copied", 1400);
      else flashButton(btn, COPY_ICON, opts.copyFailedLabel || "copy failed", 1800);
    });
  });
}

function addToken(data, type) {
  data.types.push(type);
  if (type === smd.CODE_BLOCK || type === smd.CODE_FENCE) {
    const parent = data.nodes[data.index];
    const wrap = document.createElement("div");
    wrap.className = "codeblock";
    const head = document.createElement("div");
    head.className = "cb-head";
    const langEl = document.createElement("span");
    langEl.className = "cb-lang";
    const btn = makeCopyButton(data.opts);
    head.appendChild(langEl);
    head.appendChild(btn);
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    pre.appendChild(codeEl);
    wrap.appendChild(head);
    wrap.appendChild(pre);
    parent.appendChild(wrap);
    data.nodes[++data.index] = codeEl;
    data.code = { text: "", lang: "", codeEl, langEl, btn, wrap };
    wireCopy(btn, codeEl, data.opts);
    return;
  }
  smd.default_add_token(data, type);
}

function finalizeCode(data) {
  const c = data.code;
  if (!c) return;
  if (data.opts.highlight !== false) highlightInto(c.codeEl, c.text, c.lang);
  c.wrap.setAttribute("data-lang", c.lang || "");
  c.wrap.classList.add("closed");
  c.btn.disabled = false;
}

function endToken(data) {
  const type = data.types.pop();
  if (type === smd.CODE_BLOCK || type === smd.CODE_FENCE) {
    finalizeCode(data);
    data.code = null;
  }
  smd.default_end_token(data);
}

function addText(data, text) {
  if (data.code) {
    data.code.text += text;
    data.code.codeEl.appendChild(document.createTextNode(text));
    return;
  }
  if (data.opts.animate) {
    // Stagger cascade within a flush: each span starts before the previous
    // one finishes ((n%4)*20ms delay, .15s duration). Modulo keeps long
    // outputs cascading instead of settling on a permanent max delay.
    const n = data.animN || 0;
    data.animN = n + 1;
    const span = document.createElement("span");
    span.className = "tk";
    const delay = (n % 4) * 20;
    if (delay) span.style.animationDelay = delay + "ms";
    span.appendChild(document.createTextNode(text));
    data.nodes[data.index].appendChild(span);
    return;
  }
  smd.default_add_text(data, text);
}

function setAttr(data, type, value) {
  if (data.code && type === smd.LANG) {
    const lang = String(value || "").trim().toLowerCase().split(/\s+/)[0] || "";
    data.code.lang = lang;
    data.code.langEl.textContent = lang;
    if (lang) data.code.codeEl.className = "language-" + lang;
    return;
  }
  if (type === smd.HREF || type === smd.SRC) {
    const node = data.nodes[data.index];
    const url = safeUrl(value, type === smd.SRC);
    if (url && node) {
      if (type === smd.SRC) {
        node.setAttribute("src", url);
        node.setAttribute("alt", "");
      } else {
        node.setAttribute("href", url);
        if (node.tagName === "A") {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
      }
    }
    return;
  }
  smd.default_set_attr(data, type, value);
}

/**
 * Mount a streaming Markdown renderer that appends a `.md` container to
 * `parent`. Feed chunks with `write`, finish the segment with `end`.
 */
export function mountMarkdown(parent, opts) {
  const options = opts || {};
  const root = document.createElement("div");
  root.className = "md";
  parent.appendChild(root);
  const data = {
    root,
    nodes: [root],
    index: 0,
    types: [],
    code: null,
    opts: options,
  };
  const parser = smd.parser({
    data,
    add_token: addToken,
    end_token: endToken,
    add_text: addText,
    set_attr: setAttr,
  });
  return {
    root,
    write(chunk) {
      smd.parser_write(parser, String(chunk == null ? "" : chunk));
    },
    end() {
      smd.parser_end(parser);
      if (data.code) {
        finalizeCode(data);
        data.code = null;
      }
    },
  };
}

/** Render a complete Markdown string into a fresh `.md` container. */
export function renderMarkdown(parent, text, opts) {
  const m = mountMarkdown(parent, opts);
  m.write(text);
  m.end();
  return m.root;
}
