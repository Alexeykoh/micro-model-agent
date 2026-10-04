// Tabs slice of the shared frontend state: open tabs, active/live ids and the
// composer draft attachments. Owned by `session/**`; aliased on the composed
// `S` (see `./index.js`).
export const tabs = {
  tabs: [],
  activeTabId: null,
  liveTabId: null,
  newSeq: 0,
  attachments: [],
  attachErrTimer: null,
};