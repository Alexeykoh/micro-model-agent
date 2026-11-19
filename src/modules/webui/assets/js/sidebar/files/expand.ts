// Directory expansion for the Files tab tree — вынесено из `files.ts`
// (правило ≤300). Оркестратор (`files.ts`) внедряет колбэки через
// `initExpandDeps`, чтобы не заводить цикл импортов.
import { sb } from "../state.js";
import { focusTreeRow } from "./keys.js";
import { EXPAND_DEPTH, EXPAND_DIR_CAP, EXPAND_BATCH } from "./constants.js";

interface ExpandDeps {
  /** Пометить дерево грязным (перерисуется на следующем рендере). */
  markDirty(): void;
  /** Отрисовать дерево из кэша. */
  render(): void;
  /** Обновить хром (кнопки back/forward/expand). */
  syncChrome(): void;
  /** Ленивая подгрузка листинга каталога (дедуплицированная). */
  ensureListing(path: string): Promise<void>;
}

let deps: ExpandDeps = {
  markDirty: () => {},
  render: () => {},
  syncChrome: () => {},
  ensureListing: () => Promise.resolve(),
};

/** Tab hub injects the render/chrome/fetch hooks; keeps the DAG acyclic. */
export function initExpandDeps(d: ExpandDeps): void {
  deps = d;
}

/** Collapses everything back to the workspace root. */
export function collapseAll(): void {
  sb.files.expanded.clear();
  sb.files.expandCapped = false;
  deps.markDirty();
  deps.render();
}

/** Expands every directory up to `EXPAND_DEPTH`, budgeted per request. */
export async function expandAll(): Promise<void> {
  const f = sb.files;
  if (f.expanding) return;
  f.expanding = true;
  deps.markDirty();
  deps.syncChrome();
  try {
    await expandUpTo(EXPAND_DEPTH);
  } finally {
    f.expanding = false;
    deps.markDirty();
    deps.render();
    deps.syncChrome();
  }
}

/** Keyboard `*`: reveal just the cursor's ancestors, then keep focus there. */
export function expandToDepth(): void {
  const cursor = sb.files.cursor;
  if (!cursor) return;
  const dirDepth = cursor.split("/").length - 1;
  void expandUpTo(dirDepth).then(() => focusTreeRow(sb.files.treeEl, cursor));
}

/**
 * Breadth-first expansion to `maxDepth` levels below the root, batched so the
 * tree unfolds progressively instead of blocking on the whole subtree.
 */
async function expandUpTo(maxDepth: number): Promise<void> {
  const f = sb.files;
  let budget = EXPAND_DIR_CAP;
  await deps.ensureListing("");
  let frontier = dirChildren("");
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && budget > 0; depth++) {
    const batch = frontier.slice(0, Math.min(EXPAND_BATCH, budget));
    budget -= batch.length;
    await Promise.all(batch.map((p) => deps.ensureListing(p)));
    for (const dir of batch) {
      f.expanded.add(dir);
      for (const child of dirChildren(dir)) if (!f.expanded.has(child)) frontier.push(child);
    }
    frontier = frontier.filter((p) => !f.expanded.has(p));
    deps.markDirty();
    deps.render();
  }
  f.expandCapped = budget <= 0 && frontier.length > 0;
}

function dirChildren(path: string): string[] {
  const entries = sb.files.listings.get(path) || [];
  return entries
    .filter((e) => e.type === "dir")
    .map((e) => (path ? `${path}/${e.name}` : e.name));
}
