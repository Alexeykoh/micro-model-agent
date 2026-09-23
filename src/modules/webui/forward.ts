/**
 * Agent-loop → SSE bridge for `mma web`.
 *
 * The agent loop streams text/meta chunks in tiny pieces; forwarding each one
 * verbatim would flood the browser and the socket. Text and meta are therefore
 * buffered and flushed together (`flushMs`, ~350ms), while discrete lifecycle
 * events (phase, tool start/end, turn end) flush the buffer first so ordering is
 * preserved.
 *
 * `onTurnEnd` MUST reset `state.busy = false`: the server sets `busy = true` on
 * `/api/message` and relies on this reset to accept the next submit.
 */
import type { SseEvent, WebUiState } from "./state";
import { broadcast } from "./state";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { TurnSummary } from "../types";

/**
 * SSE wire subset of {@link TurnSummary} — `textLength` is not sent to clients.
 * `success` is always required; the timing/count fields are optional so partial
 * summaries (e.g. interrupted runs) are valid.
 */
type TurnEndSummary = Pick<TurnSummary, "success" | "interrupted"> &
  Partial<Pick<TurnSummary, "durationMs" | "toolCalls">>;

export interface Forwarder {
  onText(chunk: string): void;
  onMeta(chunk: string): void;
  onPhase(phase: string): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult, durationMs: number): void;
  onTurnEnd(summary: TurnEndSummary): void;
  flushNow(): void;
}

const DEFAULT_FLUSH_MS = 350;

export function makeForwarder(
  s: WebUiState,
  sink: (ev: SseEvent) => void = (ev) => broadcast(ev, s),
  opts: { flushMs?: number } = {},
): Forwarder {
  const flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  let buf = { text: "", meta: "" };
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (buf.text) {
      sink({ type: "text", ts: Date.now(), chunk: buf.text });
      buf.text = "";
    }
    if (buf.meta) {
      sink({ type: "meta", ts: Date.now(), chunk: buf.meta });
      buf.meta = "";
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, flushMs);
  };

  return {
    onText(chunk) {
      buf.text += chunk;
      schedule();
    },
    onMeta(chunk) {
      buf.meta += chunk;
      schedule();
    },
    onPhase(phase) {
      flush();
      sink({ type: "phase", ts: Date.now(), phase });
    },
    onToolStart(call) {
      flush();
      sink({
        type: "tool_start",
        ts: Date.now(),
        toolCallId: call.id,
        name: call.name,
        args: call.arguments,
      });
    },
    onToolEnd(call, result, durationMs) {
      flush();
      sink({
        type: "tool_end",
        ts: Date.now(),
        toolCallId: call.id,
        name: call.name,
        success: result.success,
        durationMs,
      });
    },
    onTurnEnd(summary) {
      flush();
      s.busy = false;
      sink({ type: "turn_end", ts: Date.now(), ...summary });
    },
    flushNow: flush,
  };
}
