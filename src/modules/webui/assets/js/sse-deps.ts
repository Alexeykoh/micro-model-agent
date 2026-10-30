// Wiring contract for the live SSE stream (`sse.ts`), typed from the real
// implementations so it cannot drift. Types only.
import type { Dict } from "./core/store/types.js";

/** Every surface the stream drives, typed from the real implementations. */
export interface SseDeps {
  token: string | null;
  setConnStatus: typeof import("./settings.js").setConnStatus;
  resyncAfterReconnect: () => void;
  onText: typeof import("./feed.js").onText;
  onMeta: typeof import("./feed.js").onMeta;
  onReasoning: typeof import("./feed.js").onReasoning;
  onPhase: typeof import("./feed.js").onPhase;
  onToolStart: typeof import("./feed.js").onToolStart;
  onToolEnd: typeof import("./feed.js").onToolEnd;
  onPlan: typeof import("./feed.js").onPlan;
  onQuestion: typeof import("./feed.js").onQuestion;
  onTurnEnd: typeof import("./feed.js").onTurnEnd;
  onLog: typeof import("./feed.js").onLog;
  onRetract: typeof import("./feed.js").onRetract;
  onErrorEvent: typeof import("./feed.js").onErrorEvent;
  onCommandOutput: typeof import("./feed.js").onCommandOutput;
  onSubagentEvent: typeof import("./feed/subagent.js").onSubagentEvent;
  drainQueuedTurn: typeof import("./session/queue.js").drainQueuedTurn;
  sidebarSessionId: typeof import("./sidebar.js").sidebarSessionId;
  sidebarTurnEnd: typeof import("./sidebar.js").sidebarTurnEnd;
  sidebarBusy: typeof import("./sidebar.js").sidebarBusy;
  sidebarPullLog: typeof import("./sidebar.js").sidebarPullLog;
  sidebarSubagentEvent: typeof import("./sidebar.js").sidebarSubagentEvent;
  sidebarTraceEvent: typeof import("./sidebar.js").sidebarTraceEvent;
  sidebarLspEvent: typeof import("./sidebar.js").sidebarLspEvent;
  sidebarFilesChanged: typeof import("./sidebar.js").sidebarFilesChanged;
  sidebarPluginsEvent: typeof import("./sidebar.js").sidebarPluginsEvent;
  sidebarMcpEvent: typeof import("./sidebar.js").sidebarMcpEvent;
  railPlan: typeof import("./rail.js").setPlan;
  railEvent: typeof import("./rail.js").railEvent;
  faceEvent: (state: import("./loader.js").FaceState) => void;
  loaderStateFor: typeof import("./loader.js").loaderStateFor;
  composerFace: HTMLElement | null;
  getComposerToken: () => number;
  setFaceState: typeof import("./loader.js").setFaceState;
  applyUpdateEvent: typeof import("./update-ui.js").applyUpdateEvent;
  updateHooks: Parameters<typeof import("./update-ui.js").applyUpdateEvent>[1];
  setTabStatus: typeof import("./session/tabs.js").setTabStatus;
  loadConfig: typeof import("./settings.js").loadConfig;
  applyState: (d: Dict) => void;
  session: typeof import("./store.js").session;
  renderSessionsDropdown: typeof import("./session/tabs.js").renderSessionsDropdown;
  mergeUsage: typeof import("./state-sync.js").mergeUsage;
  renderUsage: typeof import("./feed.js").renderUsage;
}
