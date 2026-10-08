// Path breadcrumbs for the Files viewer header: dimmed clickable directories,
// bright file name, `…` folding for long paths. A directory crumb is the answer
// to "where was this opened from" — it reveals the folder in the tree and moves
// the tree cursor onto it.
import { el } from "../../dom.js";
import { sb } from "../state.js";
import { revealInTree } from "./tree.js";

interface CrumbDeps {
  reveal: (dirPath: string) => void;
}

let deps: CrumbDeps = { reveal: () => {} };

export function initCrumbDeps(d: Partial<CrumbDeps>): void {
  deps = { ...deps, ...d };
}

export function renderCrumbs(path: string): void {
  const box = sb.files.crumbEl;
  if (!box) return;
  box.textContent = "";
  const parts = path.split("/");
  const folded = parts.length > 4 && !sb.files.crumbsOpen;
  const shown = folded ? parts.slice(parts.length - 3) : parts;
  if (folded) {
    const more = el("button", "fcrumb more", "…");
    more.type = "button";
    more.title = path;
    more.addEventListener("click", () => {
      sb.files.crumbsOpen = true;
      renderCrumbs(path);
    });
    box.appendChild(more);
  }
  shown.forEach((name, i) => {
    if (i === shown.length - 1) {
      box.appendChild(el("span", "fcrumb cur", name));
      return;
    }
    const dirPath = shown.slice(0, i + 1).join("/");
    const crumb = el("button", "fcrumb", name);
    crumb.type = "button";
    crumb.title = dirPath;
    crumb.addEventListener("click", () => deps.reveal(dirPath));
    box.appendChild(crumb);
    box.appendChild(el("span", "fsep", "›"));
  });
}

export function clearCrumbs(): void {
  const box = sb.files.crumbEl;
  if (box) box.textContent = "";
}