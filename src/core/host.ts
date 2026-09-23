import type { OutputEvent } from "../output/types";
import { defaultOutputBus } from "../output/bus";
import type { HostBridge, HostBridgeSubmitOptions } from "../modules/types";

/** Status of a single plan step surfaced to a Host. `skipped` is not part of
 *  the host contract; execution plans map it onto a settled state. */
export type PlanStepStatus = "pending" | "in_progress" | "done" | "failed";

/** Snapshot a Host can render into a sidebar/topbar. Fields are best-effort:
 *  absent when the underlying module is not available (e.g. no session yet). */
export interface HostStateSnapshot {
  busy: boolean;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  provider?: string;
  contextUsed?: number;
  contextLimit?: number;
  costUsd?: number;
  compactionCount?: number;
  /** Prompt-cache hit rate for the last turn (0..1); absent when unknown. */
  cacheHitRate?: number;
  /** Context quality score for the last turn (0..100); absent when unknown. */
  contextQuality?: number;
  plan?: {
    steps: { text: string; status: PlanStepStatus }[];
    currentIndex: number;
  } | null;
}

/**
 * Full host surface. `HostBridge` (plugin-facing, narrow) stays the plugin
 * contract; `Host` adds the pieces web mode needs. `Repl` and `WebHost` are the
 * two implementations.
 */
export interface Host extends HostBridge {
  /** Execute a slash command line (e.g. "/status") through the shared handler map. */
  executeCommand(line: string): Promise<void>;
  /** Current state for sidebar/topbar rendering. */
  getState(): HostStateSnapshot;
}

export interface CreateHostBridgeOptions {
  isBusy: () => boolean;
  addPendingImage: (dataUrl: string) => void;
  runAgent: (text: string) => Promise<unknown>;
  interruptRun: () => void;
}

/**
 * Build the HostBridge exposed to plugins as `ctx.hostBridge`. Web clients
 * (and any other plugin) submit messages through the SAME runAgent path as
 * terminal input — rendering, session logging and single-flight guard are
 * shared, never duplicated.
 */
export function createHostBridge(opts: CreateHostBridgeOptions): HostBridge {
  return {
    isBusy: opts.isBusy,
    async submit(text: string, o?: HostBridgeSubmitOptions) {
      if (opts.isBusy()) throw new Error("agent is busy");
      for (const url of o?.images ?? []) opts.addPendingImage(url);
      return opts.runAgent(text);
    },
    interrupt() {
      if (opts.isBusy()) opts.interruptRun();
    },
    subscribeOutput: (fn: (ev: OutputEvent) => void) => defaultOutputBus.subscribe(fn),
  };
}
