// Tree rendering for the Files tab: rows are built flat and encode hierarchy in
// `data-depth` (a nested model would complicate lazy expansion and keyboard
// navigation). Split out of `sidebar/files.ts`; reads shared state from
// `./state.js` and gets the callbacks it may trigger through `initTreeDeps`.
import { el, icon } from "../../dom.js";
import { t } from "../../i18n.js";
import { sb, type FileEntry } from "../state.js";
import { focusTreeRow } from "./keys.js";

interface TreeDeps {
  ensureListing: (path: string) => Promise<void>;
  toggleDir: (path: string) => void;
  openFile: (path: string) => void;
  insertPath: (path: string) => void;
  markDirty: () => void;
  render: () => void;
}

let deps: TreeDeps = {
  ensureListing: () => Promise.resolve(),
  toggleDir: () => {},
  openFile: () => {},
  insertPath: () => {},
  markDirty: () => {},
  render: () => {},
};

export function initTreeDeps(d: Partial<TreeDeps>): void {
  deps = { ...deps, ...d };
}

/** Visible rows in document order (flat, one `.frow` per node). */
export function visibleRows(): HTMLElement[] {
  const tree = sb.files.treeEl;
  if (!tree) return [];
  return Array.from(tree.querySelectorAll<HTMLElement>(".frow"));
}

/**
 * Repaints the cursor in place. A full re-render here would drop DOM focus (rows
 * are recreated), so keyboard navigation would die after one keypress.
 */
export function paintCursor(): void {
  const cur = sb.files.cursor;
  visibleRows().forEach((r) => r.classList.toggle("cursor", r.dataset.path === cur));
}

/** Renders one directory's rows (recurses into expanded subdirectories). */
export function renderDir(parent: HTMLElement, path: string, depth: number): void {
  const entries = sb.files.listings.get(path) || [];
  if (entries.length === 0 && depth === 0) {
    parent.appendChild(el("div", "fdim", t("web.files.empty")));
    return;
  }
  for (const e of entries) {
    const childPath = path ? `${path}/${e.name}` : e.name;
    parent.appendChild(fileRow(e, childPath, depth));
    if (e.type === "dir" && sb.files.expanded.has(childPath)) {
      if (sb.files.listings.has(childPath)) {
        renderDir(parent, childPath, depth + 1);
      } else {
        const pendingLabel = sb.files.errored.has(childPath)
          ? t("web.files.error")
          : t("web.files.loading");
        const p = el("div", "fdim", pendingLabel);
        p.style.setProperty("--indent", String(depth + 1));
        parent.appendChild(p);
        void deps.ensureListing(childPath).then(() => deps.markDirty());
      }
    }
  }
  if (sb.files.truncated.has(path)) {
    const note = el("div", "fdim", t("web.files.truncated"));
    note.style.setProperty("--indent", String(depth));
    parent.appendChild(note);
  }
}

/** Builds one tree row (icon + name + attach button; шеврон — только у папок). */
function fileRow(e: FileEntry, childPath: string, depth: number): HTMLElement {
  const f = sb.files;
  const isDir = e.type === "dir";
  const sel = !isDir && f.selectedPath === childPath;
  const row = el("div", `frow${isDir ? " dir" : ""}${sel ? " sel" : ""}${f.cursor === childPath ? " cursor" : ""}`);
  row.dataset.path = childPath;
  row.dataset.kind = e.type;
  row.dataset.depth = String(depth);
  // Глубина — единственный источником отступа; CSS считает padding-left сам.
  row.style.setProperty("--indent", String(depth));
  row.tabIndex = -1;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-label", e.name);
  if (isDir) row.setAttribute("aria-expanded", String(f.expanded.has(childPath)));
  else row.setAttribute("aria-selected", String(sel));
  // Шеврон-колонка есть только у папок: пустой спан у файла читался как
  // «файл вложен на уровень ниже». Цена — иконка файла на той же глубине
  // стоит левее иконки папки (вложенность задаёт только отступ).
  if (isDir) {
    const twisty = el("span", "ftw");
    twisty.appendChild(icon(f.expanded.has(childPath) ? "chevron-down" : "chevron-right"));
    row.appendChild(twisty);
  }
  const ic = el("span", "fic");
  ic.appendChild(icon(isDir ? "folder" : "file"));
  row.appendChild(ic);
  row.appendChild(el("span", "fname", e.name));
  if (!isDir) {
    const at = el("button", "fattach");
    at.type = "button";
    at.title = t("web.files.attach");
    at.setAttribute("aria-label", `${t("web.files.attach")} ${childPath}`);
    at.appendChild(icon("paperclip"));
    at.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deps.insertPath(childPath);
    });
    row.appendChild(at);
  }
  row.addEventListener("click", () => {
    f.cursor = childPath;
    deps.markDirty();
    if (isDir) deps.toggleDir(childPath);
    else deps.openFile(childPath);
  });
  return row;
}

/**
 * Reveals a directory in the tree and moves the keyboard cursor onto it — what a
 * breadcrumb click does. Lives here because it mutates tree state (expansion +
 * cursor), not crumbs.
 */
export function revealInTree(dirPath: string): void {
  const f = sb.files;
  void deps.ensureListing(dirPath).then(() => {
    f.expanded.add(dirPath);
    f.cursor = dirPath;
    deps.markDirty();
    deps.render();
    focusTreeRow(f.treeEl, dirPath);
  });
}

/**
 * Раскрывает дерево до файла `filePath` (все каталоги-предки + листинг
 * родителя), ставит курсор на файл и фокусирует строку. Используется, когда
 * файл открывается из чата: без раскрытия предков строки в дереве ещё нет.
 */
export async function revealFile(filePath: string): Promise<void> {
  const f = sb.files;
  const parts = filePath.split("/").filter(Boolean);
  if (parts.length === 0) return;
  await deps.ensureListing("");
  let dir = "";
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    f.expanded.add(dir);
    await deps.ensureListing(dir);
  }
  if (!f.listings.has(dir)) await deps.ensureListing(dir);
  f.cursor = filePath;
  deps.markDirty();
  deps.render();
  focusTreeRow(f.treeEl, filePath);
}