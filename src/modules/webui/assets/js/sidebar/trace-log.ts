// Рендер записей `session.jsonl` в строки Trace (вынесено из trace.ts).
import type { Dict } from "../core/store/types.js";
import { TRACE_GATE_NOTICE_MS } from "./state.js";
import { gateBreakdown } from "./trace-labels.js";

/** Колбэки Trace, нужные рендеру одной записи лога. */
export interface TraceLogSink {
  append(entry: Dict): Dict;
  pushRow(entry: Dict): void;
}

export function appendLogEntry(e: Dict, sink: TraceLogSink): void {
  if (!e || typeof e.type !== "string") return;
  switch (e.type) {
    case "gate_timing": {
      // A15: сколько ход простоял в гейтах. Шум не плодим — только заметные
      // простои; строка связывает «ответ уже виден» с пост-обработкой.
      const ms = typeof e.duration === "number" ? e.duration : 0;
      if (ms < TRACE_GATE_NOTICE_MS) break;
      const gates = e.gates && typeof e.gates === "object" ? e.gates : {};
      sink.pushRow(sink.append({
          kind: "gate",
          duration: ms,
          gates,
          iteration: e.iteration,
          text: gateBreakdown(ms, gates),
        }),
      );
      break;
    }
    case "critic_check":
      sink.pushRow(sink.append({ kind: "critic", status: "check", text: e.content || "", iteration: e.iteration }),
      );
      break;
    case "critic_verdict":
      sink.pushRow(sink.append({
          kind: "critic",
          status: e.status || "",
          text: e.content || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "critic_escalation":
      sink.pushRow(sink.append({
          kind: "critic",
          status: "escalation",
          text: e.content || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "critic_error":
      sink.pushRow(sink.append({
          kind: "critic",
          status: "error",
          text: e.content || e.error || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "compaction":
      sink.pushRow(sink.append({ kind: "compaction", text: e.content || "", iteration: e.iteration }));
      break;
    case "context_probe":
      sink.pushRow(sink.append({ kind: "probe", text: e.content || "" }));
      break;
    case "llm_usage": {
      const toks =
        typeof e.totalTokens === "number"
          ? e.totalTokens
          : (e.promptTokens || 0) + (e.completionTokens || 0);
      const who = [e.model || e.provider, toks ? toks + " tok" : ""].filter(Boolean).join(" · ");
      sink.pushRow(sink.append({ kind: "usage", text: who, iteration: e.iteration }));
      break;
    }
    case "audit":
      sink.pushRow(sink.append({ kind: "audit", text: e.content || "", iteration: e.iteration }));
      break;
    case "claim_retry":
      sink.pushRow(sink.append({
          kind: "claim",
          subkind: e.kind || "",
          text: e.content || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "retract":
      sink.pushRow(sink.append({
          kind: "retract",
          text: e.content || "",
          source: e.retractSource || "",
          verdict: e.verdict || "",
          iteration: e.iteration,
        }),
      );
      break;
    case "output":
      sink.pushRow(sink.append({ kind: "output", text: e.content || "", iteration: e.iteration }));
      break;
    default:
      break;
  }
}
