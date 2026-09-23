/**
 * `OutputBus` → SSE bridge for `mma web`.
 *
 * The agent/bootstrap emit human-facing warnings and errors on the process
 * global {@link defaultOutputBus} (system-prompt overflow, context probe,
 * summarization). In terminal mode these render above the prompt; in web mode
 * nothing forwarded them, so a slow first-run summarization looked like a
 * silent hang. This subscribes to the bus and re-broadcasts the interesting
 * levels as SSE `log` events. `debug` is dropped (terminal-only noise).
 *
 * Secrets are redacted with the same point-redaction used elsewhere in the
 * web transport; the browser renders `text` via `textContent`.
 */
import type { OutputBus } from "../../output/bus";
import { defaultOutputBus } from "../../output/bus";
import type { OutputEvent, OutputLevel } from "../../output/types";
import { redactContextSecrets } from "../../core/agent/context-log";
import { broadcast, type WebUiState } from "./state";

const FORWARDED: readonly OutputLevel[] = ["info", "warn", "error"];

/** Subscribe `state` to `bus`; returns the unsubscribe (call it in `stop()`). */
export function installOutputForwarding(
  state: WebUiState,
  bus: OutputBus = defaultOutputBus,
): () => void {
  return bus.subscribe((ev: OutputEvent) => {
    if (!FORWARDED.includes(ev.level)) return;
    broadcast(
      {
        type: "log",
        ts: ev.ts,
        level: ev.level,
        source: ev.source,
        text: redactContextSecrets(ev.text),
      },
      state,
    );
  });
}
