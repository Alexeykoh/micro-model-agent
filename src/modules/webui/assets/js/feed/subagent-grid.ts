// Top-right grid of subagent mascots for `mma web`.
//
// Each cell is its own MMART instance fed by that run's events (think / type /
// tool category). The grid lives on the chat surface (not inside the run view),
// so it is visible on the parent screen too; clicking a mascot opens that run.
// The grid answers one question — "who is running right now": a finished run
// leaves it on `end` (done/error/stop), while its transcript stays reachable
// from the parent feed row. The session's newest runs are shown first (max 9).
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { tabs as tabState } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { createFace, setFaceState } from "../loader.js";
import { buf, runFaceState } from "./subagent-buffer.js";

/** Сколько ячеек максимум показываем (3 колонки × 3 ряда). */
const GRID_MAX = 9;

/** runId → сессия-владелец. Только активные прогоны: `end` снимает запись. */
const known = new Map<string, string>();
let grid: HTMLElement | null = null;
let openRun: (sessionId: string, runId: string) => void = () => {};

/**
 * Активен ли прогон. `status` не выставлен до первого `end` — это running;
 * терминальные статусы (`done`/`failed`/`interrupted`) в сетку не попадают.
 */
function isActive(runId: string): boolean {
  const meta = buf(runId).meta;
  if (!meta.runId) return false;
  return !meta.status || meta.status === "running";
}

/** Подключает колбэк открытия прогона (зовёт `subagent.ts` при init). */
export function initSubagentGrid(open: (sessionId: string, runId: string) => void): void {
  openRun = open;
}

function ensureGrid(): HTMLElement | null {
  if (grid && grid.isConnected) return grid;
  const host = document.querySelector(".chat");
  if (!host) return null;
  grid = el("div", "srun-grid");
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", t("web.subagent.grid"));
  grid.hidden = true;
  host.appendChild(grid);
  return grid;
}

/** Регистрирует активный прогон для сетки (живое событие или снимок после reload). */
export function registerRun(runId: string, sessionId: string): void {
  if (!runId || !sessionId) return;
  if (!isActive(runId)) return;
  if (known.get(runId) === sessionId) return;
  known.set(runId, sessionId);
  renderGrid();
}

/** Убирает прогон из сетки (завершился или сессия закрыта). */
function unregisterRun(runId: string): void {
  if (!known.delete(runId)) return;
  renderGrid();
}

/** Перерисовывает сетку по активным прогонам активной вкладки (новые последними). */
export function renderGrid(): void {
  const host = ensureGrid();
  if (!host) return;
  host.textContent = "";
  // Страховка от потерянного `end` (обрыв SSE): терминальный прогон в сетке
  // не живёт, даже если событие до клиента не дошло.
  for (const runId of [...known.keys()]) {
    if (!isActive(runId)) known.delete(runId);
  }
  const active = tabState.activeTabId;
  const ids = [...known.entries()]
    .filter(([runId, sessionId]) => sessionId === active && isActive(runId))
    .map(([runId]) => runId)
    .slice(-GRID_MAX);
  host.hidden = ids.length === 0;
  if (ids.length === 0) return;
  // Колонок ровно столько, сколько ячеек (до 3): при двух маскотах капсула
  // сжимается до двух колонок, а не оставляет пустой третий слот.
  host.style.gridTemplateColumns = `repeat(${Math.min(ids.length, 3)}, 28px)`;
  for (const runId of ids) {
    const meta = buf(runId).meta;
    const cell = el("button", "srun-dot" + (tabState.subagentRunId === runId ? " on" : ""));
    cell.type = "button";
    cell.dataset.runId = runId;
    const task = String(meta.task || "");
    cell.title = task || t("web.subagent.title");
    cell.setAttribute("aria-label", cell.title);
    cell.appendChild(createFace(runFaceState(buf(runId)), "sm"));
    cell.addEventListener("click", () => {
      const sid = known.get(runId);
      if (sid) openRun(sid, runId);
    });
    host.appendChild(cell);
  }
}

/** Обновляет только лицо одной ячейки (дешевле полной перерисовки). */
function updateGridFace(runId: string): void {
  if (!grid) return;
  const cell = grid.querySelector(`[data-run-id="${runId}"]`);
  const face = cell?.querySelector(".mdl") as HTMLElement | null;
  if (face) setFaceState(face, runFaceState(buf(runId)));
}

/** Событие прогона: регистрирует/обновляет ячейку; `end` её снимает. */
export function trackRun(ev: Dict): void {
  const runId = typeof ev.runId === "string" ? ev.runId : "";
  if (!runId) return;
  if (ev.kind === "start") {
    registerRun(runId, String(ev.parentSessionId || ev.sessionId || ""));
    return;
  }
  if (!known.has(runId)) return;
  if (ev.kind === "end") {
    unregisterRun(runId);
    return;
  }
  updateGridFace(runId);
}

/** Вкладка сменилась/закрыта: пересобрать сетку под новый activeTabId. */
export function refreshGrid(): void {
  renderGrid();
}
