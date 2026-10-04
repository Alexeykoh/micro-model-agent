// Feed slice of the shared frontend state: stream/turn buffers and the
// read-only run-folding bookkeeping. Owned by `feed/**`; the legacy composed
// `S` aliases these fields (see `./index.js`).
import type { Dict, MdHandle, ThinkState, ToolNode } from "./types.js";

export interface FeedSlice {
  curText: string | null;
  curMd: MdHandle | null;
  turnMd: string;
  turnRoots: HTMLElement[];
  curThink: ThinkState | null;
  lastPlanSig: string | null;
  lastUsageSig: string | null;
  lastEnvSig: string | null;
  runCount: number;
  runFails: number;
  runReconOnly: boolean;
  runNodes: HTMLElement[];
  runDuration: number;
  // biome-ignore lint/suspicious/noExplicitAny: opaque timer handle.
  busyTimer: any;
  pendingArgs: Map<string, Dict>;
  toolNodes: Map<string, ToolNode>;
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
