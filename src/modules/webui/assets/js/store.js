// Shared mutable UI state for the `mma web` frontend.
//
// Was IIFE closure scope in `app.js`. ESM live bindings cannot be reassigned
// from importers, so everything mutable lives on the `S` singleton and every
// module reads/writes `S.*` explicitly.

export const THEME_KEY = "mma-theme";
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export const S = {
  state: {
    config: null,
    registry: [],
    webToken: null,
    models: [],
    sessions: [],
    host: {},
    busy: false,
    activeSessionId: null,
    memory: undefined,
    skills: undefined,
    pluginsData: undefined,
    providers: undefined,
    providerPresets: [],
    providerForm: null,
    // Transient error shown inline in the sessions dropdown (visible without the modal).
    sessionsError: null,
  },

  tabs: [],
  activeTabId: null,
  liveTabId: null,
  newSeq: 0,
  attachments: [],
  attachErrTimer: null,

  curText: null,
  curMd: null,
  turnMd: "",
  turnRoots: [],
  curThink: null,
  lastPlanSig: null,
  lastUsageSig: null,
  lastEnvSig: null,
  runCount: 0,
  runFails: 0,
  runReconOnly: true,
  runNodes: [],
  runDuration: 0,
  busyTimer: null,
  pendingArgs: new Map(),
  toolNodes: new Map(),
};

export function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function getPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}
