// Sidebar SSE wiring (Trace / Security / LSP) — вынесено из `sse.ts`
// (правило 6: ≤300 строк). `sse.ts` остаётся владельцем потока, здесь только
// раскладка его событий по вкладкам сайдбара.
import type { Dict } from "./core/store/types.js";
import type { SseDeps } from "./sse-deps.js";

/** Всё, что нужно сайдбару от потока: разбор и фильтр чужой сессии. */
export interface SidebarSseDeps {
  parse: (e: MessageEvent) => Dict | null;
  owns: (d: Dict) => boolean;
  sidebarTraceEvent: SseDeps["sidebarTraceEvent"];
  sidebarSecurityEvent: SseDeps["sidebarSecurityEvent"];
  sidebarLspEvent: SseDeps["sidebarLspEvent"];
}

/** События Trace, которые несут смысл строкой (остальные — из журнала). */
const TRACE_EVENTS = [
  "tool_start",
  "tool_end",
  "phase",
  "plan",
  "question",
  "meta",
  "log",
  "retract",
  "index",
  "llm_request",
] as const;

/** Подписать вкладки сайдбара на SSE. */
export function attachSidebarSse(es: EventSource, deps: SidebarSseDeps): void {
  const { parse, owns, sidebarTraceEvent, sidebarSecurityEvent, sidebarLspEvent } = deps;
  // Trace: tool/text/phase/plan/question/error стримятся живьём; status/log/
  // retract/index едут по той же шине; critic/compaction/probe/usage/audit/
  // claim приходят из журнала, который Trace докачивает на turn_end.
  for (const ev of TRACE_EVENTS) {
    es.addEventListener(ev, (e) => {
      const d = parse(e);
      if (d && owns(d)) sidebarTraceEvent(ev, d);
    });
  }
  for (const ev of ["text", "reasoning"] as const) {
    es.addEventListener(ev, (e) => {
      const d = parse(e);
      if (d && owns(d)) sidebarTraceEvent(ev, d);
    });
  }
  // LSP: сервер шлёт `lsp {phase}` вокруг диагностики по запросу.
  es.addEventListener("lsp", (e) => {
    const d = parse(e);
    if (d) sidebarLspEvent(d);
  });
  // Security (U22): живой журнал отловов защиты.
  es.addEventListener("security", (e) => {
    const d = parse(e);
    if (d && owns(d)) sidebarSecurityEvent(d);
  });
}
