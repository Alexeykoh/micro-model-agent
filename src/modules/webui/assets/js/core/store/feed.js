// Feed slice of the shared frontend state: stream/turn buffers and the
// read-only run-folding bookkeeping. Owned by `feed/**`; the legacy composed
// `S` aliases these fields (see `./index.js`).
export const feed = {
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