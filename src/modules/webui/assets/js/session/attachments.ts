// Composer attachments: image picker/paste, the thumbnail strip and the drop
// zone. Split out of `composer.ts` so the composer stays under the file-size
// gate (rule 6); it owns only attachment state and never sends a turn.
import { inp, imgPicker, attachStrip, attachErr, el, icon } from "../dom.js";
import { t } from "../i18n.js";
import { tabs as tabState, MAX_IMAGES, MAX_IMAGE_BYTES } from "../store.js";
import type { Dict } from "../core/store/types.js";

let activeTabFn: () => Dict | null = () => null;
let insertPathFn: (text: string) => void = () => {};

/** Composer supplies the tab owner and draft insertion; keeps the DAG acyclic. */
export function initAttachments(deps: {
  activeTab: () => Dict | null;
  insertPath: (text: string) => void;
}): void {
  activeTabFn = deps.activeTab;
  insertPathFn = deps.insertPath;
}

function setAttachError(msg: string): void {
  if (!attachErr) return;
  attachErr.textContent = msg;
  attachErr.hidden = false;
  clearTimeout(tabState.attachErrTimer);
  tabState.attachErrTimer = setTimeout(() => {
    attachErr.hidden = true;
  }, 4000);
}

export function renderAttachments(): void {
  if (!attachStrip) return;
  attachStrip.textContent = "";
  attachStrip.hidden = tabState.attachments.length === 0;
  tabState.attachments.forEach((src: string, i: number) => {
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
      tabState.attachments.splice(i, 1);
      renderAttachments();
    });
    thumb.appendChild(rm);
    attachStrip.appendChild(thumb);
  });
  // Черновик аттачей живёт на активной вкладке (см. saveComposer/restoreComposer).
  const owner = activeTabFn();
  if (owner) owner.attachments = tabState.attachments.slice();
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

async function addFiles(files: File[]): Promise<void> {
  let err = "";
  for (const file of files) {
    if (!file || typeof file.type !== "string" || file.type.indexOf("image/") !== 0) {
      err = t("web.attach.only_images");
      continue;
    }
    if (tabState.attachments.length >= MAX_IMAGES) {
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
      if (tabState.attachments.length >= MAX_IMAGES) {
        err = t("web.attach.too_many", { max: MAX_IMAGES });
        break;
      }
      tabState.attachments.push(url);
    } catch {
      err = t("web.attach.read_failed");
    }
  }
  renderAttachments();
  if (err) setAttachError(err);
}

// --- input wiring: picker, paste and the drop zone -----------------------
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
  const files: File[] = [];
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
    const de = e as DragEvent;
    if (de.relatedTarget && inputArea.contains(de.relatedTarget as Node)) return;
    inputArea.classList.remove("dragover");
  });
  inputArea.addEventListener("drop", (e) => {
    e.preventDefault();
    inputArea.classList.remove("dragover");
    const de = e as DragEvent;
    const dt = de.dataTransfer;
    if (!dt) return;
    // Files dragged from the workspace tree carry their path; prefer it over
    // the OS payload (a dropped OS file exposes only its basename).
    const path =
      dt.getData("application/x-mma-path") ||
      firstUriPath(dt.getData("text/uri-list")) ||
      (dt.files && dt.files.length === 0 ? dt.getData("text/plain").trim() : "");
    if (path) {
      insertPathFn("@" + normalizeDropPath(path) + " ");
      return;
    }
    const files = dt.files ? Array.from(dt.files) : [];
    if (!files.length) return;
    // Shift turns a drop into a reference instead of an image attachment.
    const wantsRef = de.shiftKey || files.some((f) => !/^image\//.test(f.type || ""));
    if (wantsRef) {
      const paths = files.map(fileDropPath).filter(Boolean);
      if (paths.length) {
        insertPathFn(paths.map((p) => "@" + p + " ").join(""));
        return;
      }
    }
    addFiles(files);
  });
}

/** First usable entry of a `text/uri-list` payload (local file or bare path). */
function firstUriPath(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    // `https://…` dragged from a browser is not a workspace path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^file:/i.test(text)) return "";
    if (/\s/.test(text)) return "";
    return text;
  }
  return "";
}

/** `file:///C:/x` → `C:/x`; leaves plain paths alone. */
function normalizeDropPath(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "file:") {
      const decoded = decodeURIComponent(url.pathname);
      return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Path for a dropped OS file: Electron exposes `path`, browsers only `name`. */
function fileDropPath(file: File): string {
  const withPath = file as File & { path?: string };
  return withPath.path || file.name;
}
