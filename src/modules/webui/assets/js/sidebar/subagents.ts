// Subagents tab for `mma web`: every run of the active session (running and
// finished), newest first. A run is not a session — the list comes from the
// in-memory `GET /api/sessions/:id/subagents` store, and a click opens the same
// read-only transcript the feed row opens. Snapshots are merged into the shared
// run buffers first, so opening a run from here renders its full history.
import { api } from "../api.js";
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { formatMs } from "../format.js";
import type { Dict } from "../core/store/types.js";
import { openRun } from "../feed/subagent.js";
import { mergeSnapshot } from "../feed/subagent-buffer.js";
import { mqNarrow, sb } from "./state.js";
import { setSidebarDrawer } from "./drawer.js";

type RunRow = Dict & { runId: string };

let runs: RunRow[] = [];
let loaded = false;
let loading = false;
let unavailable = false;
let loadedFor = "";
let timer: ReturnType<typeof setTimeout> | null = null;
/** Событие пришло во время запроса: перечитать ещё раз после ответа. */
let reloadQueued = false;

function bodyEl(): HTMLElement | null {
  return document.getElementById("subagentsBody");
}

function sessionId(): string {
  return (sb.el && sb.el.dataset.sid) || "";
}

/** Глиф статуса прогона: живой / успешный / упавший / остановленный. */
function glyphOf(run: RunRow): [string, string] {
  if (!run.status || run.status === "running") return ["◇", "run"];
  if (run.status === "done") return ["✓", "ok"];
  if (run.status === "interrupted") return ["■", "dim"];
  return ["✗", "warn"];
}

function durationText(run: RunRow): string {
  const start = typeof run.startedAt === "number" ? run.startedAt : null;
  if (!start) return "";
  if (!run.status || run.status === "running") {
    const secs = Math.max(0, Math.round((Date.now() - start) / 1000));
    return t("web.subagents.running_for", { secs: String(secs) });
  }
  const end = typeof run.endedAt === "number" ? run.endedAt : start;
  return formatMs(end - start);
}

/** Мета строки: агент · модель · длительность · итерации. */
function metaText(run: RunRow): string {
  const parts: string[] = [];
  if (run.agent) parts.push(String(run.agent));
  if (run.model) parts.push(String(run.model));
  const dur = durationText(run);
  if (dur) parts.push(dur);
  if (typeof run.iterations === "number")
    parts.push(t("web.subagents.iters", { n: String(run.iterations) }));
  return parts.join(" · ");
}

function openRow(run: RunRow): void {
  const sid = sessionId();
  if (!sid || !run.runId) return;
  mergeSnapshot(run);
  openRun(sid, run.runId);
  if (mqNarrow()) setSidebarDrawer(false);
}

function runRow(run: RunRow): HTMLElement {
  const row = el("div", "sbrun");
  const [glyph, cls] = glyphOf(run);
  row.appendChild(el("span", "sbrun-g " + cls, glyph));
  const main = el("span", "sbrun-main");
  main.appendChild(el("span", "sbrun-task", String(run.task || t("web.subagents.untitled"))));
  const meta = metaText(run);
  if (meta) main.appendChild(el("span", "sbrun-meta", meta));
  row.appendChild(main);
  row.tabIndex = 0;
  row.addEventListener("click", () => openRow(run));
  row.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openRow(run);
  });
  return row;
}

/** Полный пересбор вкладки. */
export function renderSubagents(): void {
  const host = bodyEl();
  if (!host) return;
  host.textContent = "";
  if (unavailable) {
    host.appendChild(el("div", "fdim", t("web.subagents.unavailable")));
    return;
  }
  if (!loaded) {
    host.appendChild(el("div", "fdim", t("web.subagents.loading")));
    return;
  }
  if (runs.length === 0) {
    host.appendChild(el("div", "fdim", t("web.subagents.empty")));
    return;
  }
  const running = runs.filter((r) => !r.status || r.status === "running").length;
  host.appendChild(
    el(
      "div",
      "sbrun-summary",
      t("web.subagents.summary", {
        total: String(runs.length),
        running: String(running),
      }),
    ),
  );
  for (const run of runs) host.appendChild(runRow(run));
}

async function load(): Promise<void> {
  const sid = sessionId();
  if (!sid || loading) {
    if (!sid) {
      runs = [];
      loaded = true;
      renderSubagents();
    }
    return;
  }
  loading = true;
  try {
    const r = await api<{ runs?: Dict[] }>(
      "/api/sessions/" + encodeURIComponent(sid) + "/subagents",
    );
    if (!r.ok || !r.data || !Array.isArray(r.data.runs)) {
      unavailable = true;
      runs = [];
    } else {
      unavailable = false;
      runs = (r.data.runs as RunRow[])
        .filter((run) => !!run && typeof run.runId === "string")
        .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
      // Буферы общие с лентой: клик по строке откроет полный транскрипт.
      for (const run of runs) mergeSnapshot(run);
    }
    loaded = true;
  } catch {
    unavailable = true;
    runs = [];
    loaded = true;
  } finally {
    loading = false;
    if (reloadQueued && sb.active === "subagents") {
      reloadQueued = false;
      void load();
      return;
    }
    reloadQueued = false;
    renderSubagents();
  }
}

/** Сессия вкладки сменилась: список прогонов прошлой сессии больше не нужен. */
export function sidebarSubagentsSessionChanged(): void {
  loadedFor = "";
  loaded = false;
  unavailable = false;
  runs = [];
  if (sb.active === "subagents") sidebarSubagentsState();
}

/** Дёргается при активации вкладки и смене сессии. */
export function sidebarSubagentsState(): void {
  if (sb.active !== "subagents") return;
  const sid = sessionId();
  if (loadedFor !== sid) {
    loadedFor = sid;
    loaded = false;
    unavailable = false;
    runs = [];
  }
  if (!loaded && !loading) void load();
  else renderSubagents();
}

/** SSE `subagent`: список устарел. Активная вкладка перечитывает с троттлингом. */
export function sidebarSubagentEvent(): void {
  loaded = false;
  if (sb.active !== "subagents") return;
  if (loading) {
    reloadQueued = true;
    return;
  }
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void load();
  }, 250);
}
