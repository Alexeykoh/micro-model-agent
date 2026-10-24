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
import { MdNormalizer } from "./js/md-normalize.js";
import { makeCopyButton, wireCopy } from "./md-copy.js";
import type { Dict } from "./js/core/store/types.js";

// Clipboard helper lives in `./md-copy`; re-exported for existing importers.
export { copyText } from "./md-copy.js";

// Vendored `smd.js` ships its own inferred renderer-data type; our token bag is
// structurally compatible but typed loosely, so cast at the interop boundary.
type SmdData = Parameters<typeof smd.default_add_token>[0];

declare global {
  interface Window {
    hljs?: {
      getLanguage(lang: string): unknown;
      highlight(code: string, opts: { language: string; ignoreIllegals: boolean }): { value: string };
      highlightAuto(code: string): { value: string };
    };
  }
}

function nodesFromHtml(html: string): Node[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.body.childNodes).map((n) => document.importNode(n, true));
}

/** Highlight `codeEl` in place. Returns `true` when highlighting was applied. */
export function highlightInto(codeEl: HTMLElement, code: string, lang: string): boolean {
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
  } catch {
    return false;
  }
}

function safeUrl(raw: unknown, isImage: boolean): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const s = raw.trim();
  if (isImage && /^data:image\/[a-z0-9.+-]+;/i.test(s)) return s;
  try {
    const u = new URL(s, location.href);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
      return u.href;
    }
  } catch {
    /* relative or malformed */
  }
  return null;
}

function addToken(data: Dict, type: unknown): void {
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
  smd.default_add_token(data as unknown as SmdData, type as never);
}

function finalizeCode(data: Dict): void {
  const c = data.code;
  if (!c) return;
  if (data.opts.highlight !== false) highlightInto(c.codeEl, c.text, c.lang);
  c.wrap.setAttribute("data-lang", c.lang || "");
  c.wrap.classList.add("closed");
  c.btn.disabled = false;
}

function endToken(data: Dict): void {
  const type = data.types.pop();
  if (type === smd.CODE_BLOCK || type === smd.CODE_FENCE) {
    finalizeCode(data);
    data.code = null;
  }
  smd.default_end_token(data as unknown as SmdData);
}

function addText(data: Dict, text: string): void {
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
  smd.default_add_text(data as unknown as SmdData, text);
}

function setAttr(data: Dict, type: unknown, value: unknown): void {
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
  smd.default_set_attr(data as unknown as SmdData, type as never, value as string);
}

export interface MdHandle {
  root: HTMLElement;
  write(chunk: unknown): void;
  end(): void;
}

// Внутрь этих узлов живой хвост вставлять нельзя: smd считает `children.length`
// у `<table>`, чтобы отличить `<thead>` от `<tbody>`.
const TABLE_HOSTS = new Set(["TABLE", "THEAD", "TBODY", "TR"]);

/**
 * Mount a streaming Markdown renderer that appends a `.md` container to
 * `parent`. Feed chunks with `write`, finish the segment with `end`.
 */
export function mountMarkdown(parent: HTMLElement, opts?: Dict): MdHandle {
  const options = opts || {};
  const root = document.createElement("div");
  root.className = "md";
  parent.appendChild(root);
  const data: Dict = {
    root,
    nodes: [root],
    index: 0,
    types: [],
    code: null,
    opts: options,
  };
  const parser = smd.parser({
    data: data as unknown as SmdData,
    add_token: addToken,
    end_token: endToken,
    add_text: addText,
    set_attr: setAttr,
  });
  // Строки нормализуются по мере поступления (GFM, который smd не парсит:
  // таблицы без внешних `|`, `1)`, `##X`); последняя недописанная строка
  // уходит в `flush` на `end`.
  const normalizer = new MdNormalizer();
  // Живой хвост. smd придерживает недописанную строку во внутреннем буфере и
  // показывает её только по `\n`, поэтому без отдельного узла ответ не виден
  // до `end()`. Хвост живёт в том же контейнере, куда smd допишет следующую
  // строку (`data.nodes[data.index]`): иначе текст прыгает между блоками.
  const tail = document.createElement("span");
  tail.className = "md-tail";

  const placeTail = (): void => {
    const cur = data.nodes[data.index] as HTMLElement | undefined;
    const inline = cur !== undefined && cur !== root && !TABLE_HOSTS.has(cur.nodeName);
    const host = inline ? (cur as HTMLElement) : root;
    const pending = normalizer.pending();
    tail.replaceChildren();
    if (pending) {
      const lines = pending.split("\n");
      // Внутри блочного контейнера первая строка хвоста начинается с новой
      // строки; у `root` границу даёт сам блочный сосед.
      const brk = inline && host.childNodes.length > 0 && lines[0] !== "";
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 || brk) tail.appendChild(document.createElement("br"));
        if (lines[i]) tail.appendChild(document.createTextNode(lines[i]));
      }
    }
    host.appendChild(tail);
  };

  placeTail();
  return {
    root,
    write(chunk) {
      // Снять хвост до парсинга: TABLE_ROW считает `children.length`, а
      // добавленные smd узлы должны вставать после уже закоммиченного текста.
      tail.remove();
      const out = normalizer.push(String(chunk == null ? "" : chunk));
      if (out) smd.parser_write(parser, out);
      placeTail();
    },
    end() {
      tail.remove();
      smd.parser_write(parser, normalizer.flush());
      smd.parser_end(parser);
      if (data.code) {
        finalizeCode(data);
        data.code = null;
      }
    },
  };
}

/** Render a complete Markdown string into a fresh `.md` container. */
export function renderMarkdown(parent: HTMLElement, text: string, opts?: Dict): HTMLElement {
  const m = mountMarkdown(parent, opts);
  m.write(text);
  m.end();
  return m.root;
}
