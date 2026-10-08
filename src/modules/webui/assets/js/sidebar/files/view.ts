// Content painting for the Files viewer: fetch a file (already jail-checked by
// `GET /api/file`) and render it into the detail body. Split out of
// `sidebar/files.ts` so the tab module stays about state/navigation and this
// stays about "text / markdown / image / pdf / media / error".
//
// Same-origin fetch/<img> authenticates via the HttpOnly `mma_web_auth` cookie,
// so no token rides in the URL.
import { el } from "../../dom.js";
import { t } from "../../i18n.js";
import { renderMarkdown } from "../../../md.js";

export interface FetchedFile {
  ok: boolean;
  mime: string;
  text: string;
}

export function fileUrl(path: string): string {
  return "/api/file?path=" + encodeURIComponent(path);
}

export async function fetchFile(path: string): Promise<FetchedFile> {
  try {
    const res = await fetch(fileUrl(path));
    if (!res.ok) return { ok: false, mime: "", text: "" };
    const mime = res.headers.get("content-type") || "";
    const text = mime.indexOf("text/plain") === 0 ? await res.text() : "";
    return { ok: true, mime, text };
  } catch {
    return { ok: false, mime: "", text: "" };
  }
}

export function paintLoading(body: HTMLElement | null): void {
  if (!body) return;
  body.textContent = "";
  body.appendChild(el("div", "fdim", t("web.files.loading")));
}

export function paintError(body: HTMLElement | null): void {
  if (!body) return;
  body.textContent = "";
  body.appendChild(el("div", "fdim wn", t("web.files.open_failed")));
}

/** Renders a fetched file; falls back to the localized error on failure. */
export function paintFile(body: HTMLElement | null, path: string, file: FetchedFile): void {
  if (!body) return;
  if (!file.ok) return paintError(body);
  body.textContent = "";
  if (file.mime.indexOf("text/plain") === 0) paintText(body, path, file.text);
  else paintMedia(body, path, file.mime);
}

/** Text files: markdown rendered, everything else in a highlighted <pre>. */
function paintText(body: HTMLElement, path: string, text: string): void {
  const ext = extOf(path);
  if (ext === "md" || ext === "markdown") {
    const wrap = el("div", "fmd");
    renderMarkdown(wrap, text);
    body.appendChild(wrap);
    return;
  }
  const pre = el("pre", "fpre");
  const code = el("code", "fcode");
  code.textContent = text;
  const hl = window.hljs;
  if (hl) {
    try {
      const res2 = hl.getLanguage(ext)
        ? hl.highlight(text, { language: ext, ignoreIllegals: true })
        : hl.highlightAuto(text);
      code.replaceChildren(...nodesFromHtml(res2.value));
    } catch {
      /* подсветка best-effort */
    }
  }
  pre.appendChild(code);
  body.appendChild(pre);
}

/** Binary-but-viewable files: images/audio/video/PDF via native elements. */
function paintMedia(body: HTMLElement, path: string, mime: string): void {
  const src = fileUrl(path);
  if (mime.indexOf("image/") === 0) {
    const img = document.createElement("img");
    img.className = "fimg";
    img.alt = path;
    img.src = src;
    body.appendChild(img);
    return;
  }
  if (mime.indexOf("application/pdf") === 0) {
    const emb = el("embed", "fembed");
    emb.setAttribute("src", src);
    emb.setAttribute("type", "application/pdf");
    body.appendChild(emb);
    return;
  }
  const tag = mime.indexOf("audio/") === 0 ? "audio" : mime.indexOf("video/") === 0 ? "video" : null;
  if (!tag) return paintError(body);
  const media = document.createElement(tag);
  media.controls = true;
  media.src = src;
  body.appendChild(media);
}

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i + 1).toLowerCase();
}

/** highlight.js output is trusted HTML; import inertly (no `innerHTML`). */
function nodesFromHtml(html: string): Node[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.body.childNodes).map((n) => document.importNode(n, true));
}