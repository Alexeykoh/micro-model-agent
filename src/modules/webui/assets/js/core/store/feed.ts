// Feed slice of the shared frontend state. The slice itself keeps only the
// cross-feed dedup signatures (plan/usage/environment rendered by the single
// sidebar). Stream/turn bookkeeping is **per feed element** (one per open
// session tab): with parallel turns the two sessions must never share a
// streaming Markdown cursor, think block, tool map or turn accumulators —
// otherwise a background session's text bleeds into the active tab.
// See `streamStateFor(feedEl)`.
import type { Dict, MdHandle, ThinkState, ToolNode } from "./types.js";

// Per-feed (per-session-tab) streaming/turn state. Created lazily, keyed by the
// tab's feed element so every SSE handler can scope its bookkeeping to the feed
// named by the event's `sessionId` (`feedForEvent`).
export interface FeedStreamState {
  curText: string | null;
  curMd: MdHandle | null;
  /**
   * Последний ответ ассистента, даже если его Markdown-сегмент уже закрыт
   * (`finishMd` перед статус-строкой или гейтом). По нему `retract` убирает
   * именно забракованный ответ, а не пустое место: к моменту отзыва стриминг
   * уже завершён, и `curMd` обнулён.
   */
  lastAnswerRoot: HTMLElement | null;
  lastAnswerText: string;
  turnMd: string;
  turnRoots: HTMLElement[];
  curThink: ThinkState | null;
  runCount: number;
  runFails: number;
  runReconOnly: boolean;
  runNodes: HTMLElement[];
  runDuration: number;
  // biome-ignore lint/suspicious/noExplicitAny: opaque timer handle.
  busyTimer: any;
  pendingArgs: Map<string, Dict>;
  toolNodes: Map<string, ToolNode>;
  // Buffered streaming text for the next animation frame (per feed).
  pendingText: string;
  textScheduled: boolean;
}

// Cross-feed dedup signatures for the single sidebar projection.
export interface FeedSlice {
  lastPlanSig: string | null;
  lastUsageSig: string | null;
  lastEnvSig: string | null;
}

export const feed: FeedSlice = {
  lastPlanSig: null,
  lastUsageSig: null,
  lastEnvSig: null,
};

const states = new WeakMap<HTMLElement, FeedStreamState>();

function createStreamState(): FeedStreamState {
  return {
    curText: null,
    curMd: null,
    lastAnswerRoot: null,
    lastAnswerText: "",
    turnMd: "",
    turnRoots: [],
    curThink: null,
    runCount: 0,
    runFails: 0,
    runReconOnly: true,
    runNodes: [],
    runDuration: 0,
    busyTimer: null,
    pendingArgs: new Map(),
    toolNodes: new Map(),
    pendingText: "",
    textScheduled: false,
  };
}

// Returns the streaming/turn state owned by `feedEl`, creating it on first use.
export function streamStateFor(feedEl: HTMLElement): FeedStreamState {
  let s = states.get(feedEl);
  if (!s) {
    s = createStreamState();
    states.set(feedEl, s);
  }
  return s;
}
