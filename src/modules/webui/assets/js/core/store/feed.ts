// Feed slice of the shared frontend state: stream/turn buffers and the
// read-only run-folding bookkeeping. Owned by `feed/**`; the legacy composed
// `S` aliases these fields (see `./index.js`).
export interface FeedSlice {
  curText: HTMLElement | null;
  curMd: HTMLElement | null;
  turnMd: string;
  turnRoots: HTMLElement[];
  curThink: HTMLElement | null;
  lastPlanSig: string | null;
  lastUsageSig: string | null;
  lastEnvSig: string | null;
  runCount: number;
  runFails: number;
  runReconOnly: boolean;
  runNodes: HTMLElement[];
  runDuration: number;
  // biome-ignore lint/suspicious/noExplicitAny: opaque DOM node / timer payloads.
  busyTimer: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque tool-call bookkeeping.
  pendingArgs: Map<string, any>;
  toolNodes: Map<string, HTMLElement>;
}

export const feed: FeedSlice = {
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
