export type OutputLevel = "debug" | "info" | "warn" | "error";
export type OutputKind = "log" | "raw" | "block";
export type OutputStream = "stdout" | "stderr";

export interface OutputEvent {
  id: number;
  ts: number;
  level: OutputLevel;
  /** Producer tag: "mma", "indexer", "probe.context", "tool:bash". */
  source: string;
  kind: OutputKind;
  /** Terminal-ready text (may contain ANSI). */
  text: string;
  stream?: OutputStream;
  /** Machine-readable payload for non-terminal surfaces. */
  data?: Record<string, unknown>;
}

export type OutputSubscriber = (ev: OutputEvent) => void;

export interface OutputSink {
  emit(ev: Omit<OutputEvent, "id" | "ts">): OutputEvent;
}
