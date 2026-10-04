// Session slice of the shared frontend state: the sessions list, host snapshot,
// per-session run/queue flags and reasoning support. Owned by `session/**` +
// `app.js`; aliased on the composed `S` (`./index.js`).
import type { Dict } from "./types.js";

export interface SessionSlice {
  sessions: Dict[];
  host: Dict;
  busy: boolean;
  activeSessionId: string | null;
  runningSessionId: string | null;
  runningSessionIds: string[];
  queued: Record<string, number>;
  sessionsError: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque reasoning payload.
  reasoning: any;
}

export const session: SessionSlice = {
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
