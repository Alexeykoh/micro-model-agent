// Session slice of the shared frontend state: the sessions list, host snapshot,
// per-session run/queue flags and reasoning support. Owned by `session/**` +
// `app.js`; aliased on the composed `S` (`./index.js`).
export const session = {
  sessions: [],
  host: {},
  busy: false,
  activeSessionId: null,
  runningSessionId: null,
  runningSessionIds: [],
  queued: {},
  sessionsError: null,
  reasoning: undefined,
};