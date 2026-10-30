// Trace row labels and severity — shared by the live list (`trace.ts`) and the
// detail pane (`trace-detail.ts`). Split out to keep both files ≤300 lines.
import { t } from "../i18n.js";
import { labelOf } from "../format.js";
import type { TraceEntry } from "./state.js";

export function phaseLabel(phase: unknown): string {
  if (phase === "composing") return t("web.rail.composing");
  if (phase === "tool") return t("web.rail.working");
  if (phase === "thinking") return t("web.action.thinking");
  return String(phase || "");
}

/**
 * Имя гейта, отозвавшего черновик. Сторонние/безымянные отзывы получают
 * нейтральное «проверка»: врать про критика нельзя (A13).
 */
export function retractSourceLabel(source: unknown): string {
  if (source === "critic") return t("web.feed.retract_source_critic");
  if (source === "hallucination") return t("web.feed.retract_source_hallucination");
  if (source === "audit") return t("web.feed.retract_source_audit");
  return t("web.feed.retract_source_check");
}
/**
 * Разбивка простоя по гейтам (A15). Нули опускаем: «критик 2400 · аудит 800»
 * читается, а «hallucination 0» — шум.
 */
export function gateBreakdown(ms: number, gates: Record<string, unknown>): string {
  const num = (v: unknown): number => (typeof v === "number" ? Math.round(v) : 0);
  const labels: Record<string, string> = {
    hallucination: "web.sidebar.trace_gate_hallucination",
    critic: "web.sidebar.trace_gate_critic",
    audit: "web.sidebar.trace_gate_audit",
  };
  const parts = Object.entries(labels)
    .map(([key, label]) => [label, num(gates[key])] as const)
    .filter(([, value]) => value > 0)
    .map(([label, value]) => t(label) + " " + value + " ms");
  return [t("web.sidebar.trace_gate_total", { ms: Math.round(ms) }), ...parts].join(" · ");
}

/** Строка Trace для `gate_timing`: сколько ход простоял в каждом гейте. */
export function gateLabel(entry: TraceEntry): string {
  const gates = entry.gates && typeof entry.gates === "object" ? entry.gates : {};
  const ms = typeof entry.duration === "number" ? entry.duration : 0;
  return t("web.sidebar.trace_gate_timing", {
    ms: Math.round(ms),
    critic: typeof gates.critic === "number" ? Math.round(gates.critic) : 0,
    audit: typeof gates.audit === "number" ? Math.round(gates.audit) : 0,
  });
}

export function rowLabel(entry: TraceEntry): string {
  switch (entry.kind) {
    case "phase":
      return phaseLabel(entry.phase);
    case "plan":
      return t("web.sidebar.trace_plan");
    case "question":
      return t("web.sidebar.trace_question");
    case "text":
      return t("web.sidebar.trace_text", { count: entry.chars || 0 });
    case "reasoning":
      return t("web.sidebar.trace_reasoning", { count: entry.chars || 0 });
    case "status":
      return t("web.sidebar.trace_status");
    case "log":
      return t("web.sidebar.trace_log", { level: entry.level || "" });
    case "retract":
      return entry.source
        ? t("web.sidebar.trace_retract_src", { source: retractSourceLabel(entry.source) })
        : t("web.sidebar.trace_retract");
    case "index":
      return t("web.sidebar.trace_index", { phase: entry.phase || "" });
    case "critic":
      return t("web.sidebar.trace_critic", { status: entry.status || "" });
    case "compaction":
      return t("web.sidebar.trace_compaction");
    case "probe":
      return t("web.sidebar.trace_probe");
    case "usage":
      return t("web.sidebar.trace_usage");
    case "audit":
      return t("web.sidebar.trace_audit");
    case "claim":
      return t("web.sidebar.trace_claim", { kind: entry.subkind || "" });
    case "output":
      return t("web.sidebar.trace_output");
    case "gate":
      return gateLabel(entry);
    default:
      return labelOf(entry.name);
  }
}

export function isWarn(entry: TraceEntry): boolean {
  return (
    entry.kind === "tool_fail" ||
    entry.kind === "error" ||
    entry.kind === "claim" ||
    (entry.kind === "critic" && entry.status === "critical") ||
    (entry.kind === "log" && (entry.level === "warn" || entry.level === "error"))
  );
}
