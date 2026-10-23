// Tabs slice of the shared frontend state: open tabs, active/live ids and the
// composer draft attachments. Owned by `session/**`; aliased on the composed
// `S` (see `./index.js`).
import type { Dict } from "./types.js";

export interface TabsSlice {
  tabs: Dict[];
  activeTabId: string | null;
  liveTabId: string | null;
  newSeq: number;
  attachments: string[];
  /** Открытый прогон субагента (runId) — лента скрыта, композер недоступен. */
  subagentRunId: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque timer handle.
  attachErrTimer: any;
}

export const tabs: TabsSlice = {
  tabs: [],
  activeTabId: null,
  liveTabId: null,
  newSeq: 0,
  attachments: [],
  subagentRunId: null,
  attachErrTimer: null,
};
