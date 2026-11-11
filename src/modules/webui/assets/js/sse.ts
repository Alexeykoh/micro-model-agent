// One live EventSource for the whole browser window: the server delivers every
// session's events, and each tab routes them client-side (`feedForEvent` by
// `sessionId`). A single stream keeps ALL open tabs (background included)
// streaming live — no per-tab reconnect. `app.ts` injects the feed/sidebar/
// rail/face wiring; this module only owns the stream.
import type { Dict } from "./core/store/types.js";
import type { SseDeps } from "./sse-deps.js";
import { noteChunk as speedChunk } from "./speed.js";
import { attachSidebarSse } from "./sse-sidebar.js";
import { attachFaceSse } from "./sse-face.js";
import { attachActivityStream } from "./core/activity-stream.js";
// The model list is refreshed in the background after a provider/model switch
// (INV-W5); the server announces the result with a `models` event, so the
// selector repaints without a second GET racing the refresh. Direct import
// (not via `SseDeps`) keeps the composition root in `app.ts` untouched.
import { loadModels } from "./settings/write.js";
export function connectSSE(deps: SseDeps): void {
  const {
    token,
    setConnStatus,
    resyncAfterReconnect,
    onText,
    onMeta,
    onReasoning,
    onPhase,
    onToolStart,
    onToolEnd,
    onPlan,
    onQuestion,
    onTurnEnd,
    onLog,
    onRetract,
    onCritic,
    onErrorEvent,
    onCommandOutput,
    onSubagentEvent,
    drainQueuedTurn,
    sidebarSessionId,
    sidebarTurnEnd,
    sidebarBusy,
    sidebarPullLog,
    sidebarSubagentEvent,
    sidebarTraceEvent,
    sidebarLspEvent,
    sidebarFilesChanged,
    sidebarPluginsEvent,
    sidebarMcpEvent,
    sidebarSecurityEvent,
    railPlan,
    railEvent,
    faceEvent,
    loaderStateFor,
    composerFace,
    getComposerToken,
    setFaceState,
    applyUpdateEvent,
    updateHooks,
    setTabStatus,
    loadConfig,
    refreshSidebar,
    applyState,
    session,
    renderSessionsDropdown,
    mergeUsage,
    renderUsage,
  } = deps;
  const sseUrl = "/events" + (token ? "?token=" + encodeURIComponent(token) : "");
  const es = new EventSource(sseUrl);
  let dropped = false;
  es.onopen = () => {
    if (!dropped) return;
    dropped = false;
    setConnStatus(false);
    resyncAfterReconnect();
  };
  es.onerror = (e) => {
    // A server-sent `event: error` also lands here but carries `data`; only a
    // real transport drop has none. Don't flag a live stream as disconnected.
    if (e && typeof (e as MessageEvent).data === "string") return;
    dropped = true;
    setConnStatus(true);
  };
  const parse = (e: MessageEvent): Dict | null => {
    try {
      return JSON.parse(e.data) as Dict;
    } catch {
      return null;
    }
  };
  // Sidebar Trace follows its own session: drop events stamped with a different
  // sessionId (background runners). Events without one are global/legacy.
  const sidebarOwns = (d: Dict) => !d.sessionId || d.sessionId === sidebarSessionId();
  // Фаза хода — общий источник правды для ленты и рельса
  // (`core/activity.ts`). Подписка идёт ДО таблицы обработчиков: фаза должна
  // обновиться раньше отрисовки строки «думаю».
  attachActivityStream(es, parse);
  // SSE event → feed handler table. `command`/`state`/`error` need envelope
  // checks and stay bespoke below; everything else is `parse → null-guard → call`.
  const handlers: Array<[string, (d: Dict) => void]> = [
    ["text", (d) => onText(d.chunk || "", d.sessionId)],
    ["meta", (d) => onMeta(d.chunk || "", d.sessionId, d.kind)],
    [
      "reasoning",
      (d) =>
        onReasoning(d.chunk || "", d.sessionId, {
          level: typeof d.level === "string" ? d.level : undefined,
          source: typeof d.source === "string" ? d.source : undefined,
        }),
    ],
    ["phase", (d) => onPhase(d.phase, d.sessionId)],
    ["tool_start", onToolStart],
    ["tool_end", onToolEnd],
    ["plan", onPlan],
    ["question", onQuestion],
    [
      "turn_end",
      (d) => {
        onTurnEnd(d);
        drainQueuedTurn(d.sessionId);
        if (sidebarOwns(d)) {
          sidebarTurnEnd(d.turnSeq);
          sidebarBusy(false);
          void sidebarPullLog();
        }
      },
    ],
    ["log", onLog],
    ["critic", (d) => onCritic(d as Dict, d.sessionId)],
    [
      "retract",
      (d) =>
        onRetract(d.reason || "", d.sessionId, {
          source: typeof d.source === "string" ? d.source : undefined,
          label: typeof d.label === "string" ? d.label : undefined,
          iteration: typeof d.iteration === "number" ? d.iteration : undefined,
          verdict: typeof d.verdict === "string" ? d.verdict : undefined,
        }),
    ],
    [
      "subagent",
      (d) => {
        onSubagentEvent(d);
        sidebarSubagentEvent();
      },
    ],
  ];
  for (const [event, fn] of handlers) {
    es.addEventListener(event, (e) => {
      const d = parse(e);
      if (d) fn(d);
    });
  }
  // Activity rail: its own listeners — feed handlers stay untouched.
  for (const ev of ["tool_start", "tool_end", "text", "plan"]) {
    es.addEventListener(ev, (e) => {
      const d = parse(e);
      if (!d) return;
      if (ev === "text") speedChunk(d.sessionId, d.chunk || "");
      if (ev === "plan") railPlan(d);
      else railEvent(ev, d.name);
    });
  }
  // Live tok/s в рельсе: reasoning — тоже генерация, иначе во время фазы
  // размышлений скорость пуста (до первого text). Счётчик событий рельса тут
  // не трогаем — только скорость.
  es.addEventListener("reasoning", (e) => {
    const d = parse(e);
    if (d) speedChunk(d.sessionId, d.chunk || "");
  });
  // Composer face (MMART): one persistent mascot that reflects the live state
  // (`sse-face.ts`, чтобы этот файл оставался ≤300 строк).
  attachFaceSse(es, {
    parse,
    faceEvent,
    loaderStateFor,
    composerFace,
    getComposerToken,
    setFaceState,
    applyUpdateEvent,
    updateHooks,
  });
  // Per-tab status dots: its own listeners — feed handlers stay untouched
  // (source-level guards pin the handler table above). Working streams mark the
  // owner tab, `question` marks waiting-for-you, `turn_end`/`error` settle it.
  // Completion never steals focus, only the badge.
  for (const ev of ["text", "reasoning", "phase", "tool_start", "plan"]) {
    es.addEventListener(ev, (e) => {
      const d = parse(e);
      if (d && d.sessionId) setTabStatus(d.sessionId, "working");
    });
  }
  es.addEventListener("question", (e) => {
    const d = parse(e);
    if (d && d.sessionId) setTabStatus(d.sessionId, "waiting");
  });
  es.addEventListener("turn_end", (e) => {
    const d = parse(e);
    if (d && d.sessionId)
      setTabStatus(d.sessionId, d.success === false && !d.interrupted ? "failed" : "idle");
  });
  // Sidebar Trace / Security / LSP: живые события вкладок (вынесено в
  // `sse-sidebar.ts`, чтобы этот файл оставался ≤300 строк).
  attachSidebarSse(es, {
    parse,
    owns: sidebarOwns,
    sidebarTraceEvent,
    sidebarSecurityEvent,
    sidebarLspEvent,
  });
  // Files tab: workspace watcher fired — re-read the expanded directories.
  es.addEventListener("files", () => sidebarFilesChanged());
  es.addEventListener("plugins", () => {
    sidebarPluginsEvent();
    sidebarMcpEvent();
  });
  // Config changed anywhere (settings write or a slash command) — re-read it so
  // the open Settings panel and the composer selectors never show a stale value.
  // Sidebar usage is a projection too: a provider switch may change the live
  // context probe without a following turn, so re-read the active tab state.
  es.addEventListener("config", () => {
    void loadConfig();
    void refreshSidebar?.();
  });
  // The model list finished its background refresh (provider/model switch) —
  // re-read it so the selectors repaint with the new provider's models.
  es.addEventListener("models", () => {
    void loadModels();
  });
  es.addEventListener("command", (e) => {
    const d = parse(e);
    if (d && typeof d.text === "string") onCommandOutput(d.text, d.sessionId);
  });
  es.addEventListener("state", (e) => {
    const d = parse(e);
    if (!d) return;
    sidebarBusy(!!d.busy);
    applyState(d);
  });
  es.addEventListener("sessions", (e) => {
    const d = parse(e);
    if (d && Array.isArray(d.sessions)) {
      session.sessions = d.sessions;
      renderSessionsDropdown();
    }
  });
  // Live context metrics while a turn runs (server broadcasts `usage` every
  // ~800ms): merge into the owning tab's snapshot without a state re-fetch.
  es.addEventListener("usage", (e) => {
    const d = parse(e);
    if (!d || !d.usage || typeof d.usage !== "object") return;
    const owner = d.usageSessionId || d.sessionId || null;
    if (mergeUsage(owner, d.usage)) renderUsage(session.host);
  });
  es.addEventListener("error", (e) => {
    if (!(e as MessageEvent).data) return;
    const d = parse(e as MessageEvent);
    if (d) {
      if (d.sessionId) setTabStatus(d.sessionId, "failed");
      onErrorEvent(d);
      sidebarTraceEvent("error", d);
    }
  });
}
