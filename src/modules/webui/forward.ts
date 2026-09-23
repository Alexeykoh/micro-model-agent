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
import { redactContextSecrets } from "../../core/agent/context-log";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { HostStateSnapshot } from "../../core/host";
import type { TurnSummary } from "../types";

/**
 * Non-null plan snapshot carried by the dedicated SSE `plan` event. Reuses the
 * host contract so the browser card and the sidebar render the same shape.
 */
export type PlanSnapshot = NonNullable<HostStateSnapshot["plan"]>;

/**
 * Redact credential-shaped strings anywhere inside a tool-argument object,
 * preserving its shape (the browser renders `args` as a structured object).
 * Reuses the same point-redaction as {@link scrubError} — generic scrubbing
 * would mangle ordinary arguments.
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return redactContextSecrets(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = scrubValue(val);
    return out;
  }
  return value;
}

export function scrubToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubValue(args);
  return scrubbed !== null && typeof scrubbed === "object"
    ? (scrubbed as Record<string, unknown>)
    : {};
}

/**
 * Per-tool caps for the tool-result body sent to the browser. Long output
 * (bash logs, file reads, search hits) is clipped so a single event can never
 * blow up the socket or the feed; the marker keeps the truncation honest.
 */
const TOOL_OUTPUT_CAPS: Record<string, number> = {
  browser: 8000,
  web_search: 6000,
  web_fetch: 4000,
  web_browse: 4000,
  bash: 16000,
  read_file: 12000,
  list_dir: 4000,
  grep: 4000,
  glob: 2000,
  download_file: 2000,
};
const DEFAULT_OUTPUT_CAP = 6000;

export function clipToolOutput(toolName: string, output: string): string {
  const cap = TOOL_OUTPUT_CAPS[toolName] ?? DEFAULT_OUTPUT_CAP;
  if (output.length <= cap) return output;
  return output.slice(0, cap) + `\n… [truncated from ${output.length.toLocaleString()} chars]`;
}

/**
 * SSE wire subset of {@link TurnSummary} — `textLength` is not sent to clients.
 * `success` is always required; the timing/count fields are optional so partial
 * summaries (e.g. interrupted runs) are valid.
 */
export type TurnEndSummary = Pick<TurnSummary, "success" | "interrupted"> &
  Partial<Pick<TurnSummary, "durationMs" | "toolCalls">>;

export interface Forwarder {
  onText(chunk: string): void;
  onMeta(chunk: string): void;
  onPhase(phase: string): void;
  onToolStart(call: ToolCall): void;
  onToolEnd(call: ToolCall, result: ToolResult, durationMs: number): void;
  /** Dedicated plan snapshot event (emitted after a `plan`/`todo` tool ends). */
  onPlan(plan: PlanSnapshot): void;
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
        args: scrubToolArgs(call.arguments),
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
        output: redactContextSecrets(clipToolOutput(call.name, result.output || "")),
      });
    },
    onPlan(plan) {
      flush();
      sink({
        type: "plan",
        ts: Date.now(),
        steps: plan.steps,
        currentIndex: plan.currentIndex,
      });
    },
    onTurnEnd(summary) {
      // Ownership: the forwarder is the single emitter of `turn_end` and the
      // single busy-reset for any turn that actually started. It also clears
      // the reservation token so a late `submit` failure callback cannot clear
      // a newer turn's slot.
      flush();
      s.busy = false;
      s.agentRunning = false;
      s.turnToken = null;
      sink({ type: "turn_end", ts: Date.now(), ...summary });
    },
    flushNow: flush,
  };
}
