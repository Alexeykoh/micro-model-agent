// Subagent run view (`mma web`): click a `subagent` row → read-only transcript
// of that run; chips switch between concurrent runs; `← к чату`/Esc returns to
// the parent feed, which stays mounted (detached) so SSE keeps filling it.
//
// Runs are in-memory on the server (`GET /api/sessions/:id/subagents`) and live
// on SSE `subagent`. Buffers (`subagent-buffer.ts`) merge by `seq`, so opening
// mid-run or re-opening a finished run never duplicates lines.
import { el } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { tabs as tabState, hooks } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { createFace, setFaceState } from "../loader.js";
import { makeRunRender, renderRunEvent, type RunRender } from "./subagent-render.js";
import {
  buf,
  mergeEvent,
  mergeSnapshot,
  runFaceState,
  sessionRuns,
  statusText,
} from "./subagent-buffer.js";
import {
  initSubagentGrid,
  refreshGrid,
  registerRun,
  trackRun,
} from "./subagent-grid.js";

interface View {
  sessionId: string;
  runId: string;
  root: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
  state: HTMLElement;
  chips: HTMLElement;
  face: HTMLElement;
  render: RunRender;
  timer: number | null;
  started: number;
}

let view: View | null = null;
const seeded = new Set<string>();

/** Контейнер ленты: ищем в документе при каждом обращении (тесты/поздний boot). */
function msgsEl(): HTMLElement {
  const node = document.getElementById("msgs");
  if (!node) throw new Error("subagent view: #msgs is missing");
  return node;
}

function renderChips(v: View): void {
  v.chips.textContent = "";
  const list = sessionRuns(v.sessionId);
  if (list.length <= 1) {
    v.chips.hidden = true;
    return;
  }
  v.chips.hidden = false;
  for (const meta of list) {
    const id = String(meta.runId || "");
    if (!id) continue;
    const chip = el("button", "srun-chip" + (id === v.runId ? " on" : ""));
    chip.type = "button";
    chip.textContent = String(meta.task || "").slice(0, 80) || t("web.subagent.title");
    chip.title = String(meta.task || "");
    chip.addEventListener("click", () => openRun(v.sessionId, id));
    v.chips.appendChild(chip);
  }
}

function setHeader(v: View, meta: Dict): void {
  v.title.textContent = String(meta.task || t("web.subagent.title"));
  v.title.title = String(meta.task || "");
  v.state.textContent = statusText(meta, v.started);
  v.state.className = "srun-state st-" + String(meta.status || "running");
  setFaceState(v.face, runFaceState(buf(v.runId)));
}

function renderAll(v: View): void {
  const b = buf(v.runId);
  v.body.textContent = "";
  v.render = makeRunRender(v.body);
  for (const ev of [...b.events].sort((a, c) => Number(a.seq || 0) - Number(c.seq || 0))) {
    renderRunEvent(v.render, ev);
  }
  setHeader(v, b.meta);
  renderChips(v);
  msgsEl().scrollTop = msgsEl().scrollHeight;
}

function stopTimer(v: View): void {
  if (v.timer !== null) {
    window.clearInterval(v.timer);
    v.timer = null;
  }
}

function buildRoot(sessionId: string): Omit<View, "runId" | "render" | "timer" | "started"> {
  const root = el("div", "srun");
  const top = el("div", "srun-top");
  const back = el("button", "srun-back");
  back.type = "button";
  back.textContent = "← " + t("web.subagent.back");
  back.addEventListener("click", () => closeRun());
  top.appendChild(back);
  const faceSlot = el("span", "srun-face-top");
  const face = createFace("think", "sm");
  faceSlot.appendChild(face);
  top.appendChild(faceSlot);
  const title = el("span", "srun-title", t("web.subagent.title"));
  top.appendChild(title);
  const state = el("span", "srun-state", t("web.subagent.running"));
  top.appendChild(state);
  root.appendChild(top);
  const chips = el("div", "srun-chips");
  chips.hidden = true;
  root.appendChild(chips);
  const note = el("div", "srun-note", t("web.subagent.readonly"));
  root.appendChild(note);
  const body = el("div", "srun-body");
  root.appendChild(body);
  return { sessionId, root, body, title, state, chips, face };
}

/** Открывает прогон (или переключает текущий вид на другой прогон). */
export function openRun(sessionId: string, runId: string): void {
  if (!sessionId || !runId) return;
  if (view && view.sessionId !== sessionId) closeRun(false);
  if (view && view.runId === runId) return;
  const tab = tabState.tabs.find((x) => x.id === sessionId);
  if (!tab) return;
  if (!view) {
    tab.srunScroll = msgsEl().scrollTop;
    view = {
      ...buildRoot(sessionId),
      runId,
      render: makeRunRender(el("div")),
      timer: null,
      started: Number(buf(runId).meta.startedAt || Date.now()),
    };
    msgsEl().replaceChildren(view.root);
    document.querySelector(".chat")?.classList.add("srun-open");
  }
  view.runId = runId;
  view.started = Number(buf(runId).meta.startedAt || Date.now());
  tabState.subagentRunId = runId;
  renderAll(view);
  stopTimer(view);
  if (String(buf(runId).meta.status || "running") === "running") {
    view.timer = window.setInterval(() => {
      if (view) setHeader(view, buf(view.runId).meta);
    }, 1000);
  }
  refreshGrid();
  void seedSubagentRuns(sessionId);
}

/** Закрывает вид и возвращает ленту родительской вкладки как была. */
export function closeRun(restore = true): void {
  if (!view) return;
  stopTimer(view);
  const tab = tabState.tabs.find((x) => x.id === view?.sessionId);
  view = null;
  tabState.subagentRunId = null;
  document.querySelector(".chat")?.classList.remove("srun-open");
  if (tab && restore) {
    msgsEl().replaceChildren(tab.feed);
    msgsEl().scrollTop = Number(tab.srunScroll || 0);
    tab.srunScroll = 0;
  }
  refreshGrid();
}

/** Перехватывает SSE `subagent`: буфер, привязка строки, живой рендер. */
export function onSubagentEvent(d: Dict): void {
  if (!mergeEvent(d)) return;
  const b = buf(d.runId);
  trackRun(d);
  if (d.kind === "start") {
    markRow(String(d.sessionId || ""), String(d.parentToolCallId || ""), d.runId);
  }
  updateRowFace(d.runId);
  if (!view || view.runId !== d.runId) return;
  renderRunEvent(view.render, d);
  setFaceState(view.face, runFaceState(b));
  setHeader(view, b.meta);
  if (d.kind === "end") {
    stopTimer(view);
    renderChips(view);
  }
  if (d.kind === "text" || d.kind === "tool_end") msgsEl().scrollTop = msgsEl().scrollHeight;
}

/** Обновляет мини-маскот строки субагента в родительской ленте. */
function updateRowFace(runId: string): void {
  const meta = buf(runId).meta;
  const sessionId = String(meta.parentSessionId || "");
  if (!sessionId) return;
  const tab = tabState.tabs.find((x) => x.id === sessionId);
  const row = tab?.feed?.querySelector?.(`[data-run-id="${runId}"]`);
  const face = row?.querySelector?.(".srun-face .mdl") as HTMLElement | null;
  if (face) setFaceState(face, runFaceState(buf(runId)));
}

/** Помечает строку `subagent` кликабельной (runId приходит в SSE `start`). */
function markRow(sessionId: string, toolCallId: string, runId: string): void {
  if (!sessionId || !toolCallId) return;
  const tab = tabState.tabs.find((x) => x.id === sessionId);
  const row = tab?.feed?.querySelector?.(
    `[data-tool-call-id="${toolCallId.replace(/["\\]/g, "\\$&")}"]`,
  ) as HTMLElement | null;
  if (!row) return;
  row.dataset.runId = runId;
  row.classList.add("srun-link");
}

/** Догружает снимки прогонов сессии (после reload/реконнекта или клика). */
export async function seedSubagentRuns(sessionId: string): Promise<void> {
  if (!sessionId || seeded.has(sessionId)) return;
  seeded.add(sessionId);
  const r = await api<{ runs?: Dict[] }>(
    "/api/sessions/" + encodeURIComponent(sessionId) + "/subagents",
  );
  if (!r.ok || !r.data || !Array.isArray(r.data.runs)) return;
  for (const snap of r.data.runs) {
    const id = mergeSnapshot(snap);
    if (!id) continue;
    registerRun(id, sessionId);
    if (snap.parentToolCallId) {
      markRow(sessionId, String(snap.parentToolCallId), id);
    }
  }
  if (view && view.sessionId === sessionId) renderAll(view);
  refreshGrid();
}

/** Клик по строке без runId: ищем прогон по tool call через REST. */
async function openByToolCall(sessionId: string, toolCallId: string): Promise<void> {
  const r = await api<{ runs?: Dict[] }>(
    "/api/sessions/" + encodeURIComponent(sessionId) + "/subagents?toolCallId=" + encodeURIComponent(toolCallId),
  );
  const run = r.ok && r.data && Array.isArray(r.data.runs) ? r.data.runs[0] : null;
  const id = run ? String(run.runId || "") : "";
  if (id) openRun(sessionId, id);
}

/** Подключает делегированный клик и Esc; звать один раз при старте UI. */
export function initSubagentView(): void {
  initSubagentGrid(openRun);
  // Замена ленты вкладки в `#msgs` (open/close/reset) закрывает вид: лента
  // прежней вкладки остаётся своей и не должна переезжать в чужой таб.
  hooks.beforeFeedMount = () => {
    if (view) closeRun(false);
    refreshGrid();
    // Сетка показывает и прогоны прошлых ходов: поднимаем снимки сессии.
    if (tabState.activeTabId) void seedSubagentRuns(String(tabState.activeTabId));
  };
  msgsEl().addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    const row = target?.closest?.(".act[data-tool-call-id]") as HTMLElement | null;
    if (!row) return;
    const tab = tabState.tabs.find((x) => x.feed && x.feed.contains(row));
    if (!tab) return;
    const runId = row.dataset.runId;
    if (runId) openRun(String(tab.id), runId);
    else if (row.dataset.toolCallId) void openByToolCall(String(tab.id), row.dataset.toolCallId);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && view) {
      e.preventDefault();
      closeRun();
    }
  });
}
