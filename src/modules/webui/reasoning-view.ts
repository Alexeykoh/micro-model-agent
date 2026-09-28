/**
 * Reasoning read shape for the `mma web` selector row.
 *
 * Pure config → view projection (same pattern as `providers-view.ts`):
 * no HTTP, no persistence, no secrets. Derived per request from the live
 * config object, so it is always fresh without any reconfigure plumbing —
 * `state.config` aliases the object the agent mutates.
 */
import type { AppConfig, ReasoningStrategy } from "../../config/types";
import { BUILTIN_PROVIDERS } from "../providers/presets";
import { activeProviderEndpoint } from "../providers/manager";
import { getCachedProbeResult } from "../reasoning/probe";

/** Reasoning support of the active provider+model pair. */
export interface ReasoningView {
  /** Mechanism the active provider preset declares (`none` = unsupported). */
  strategy: ReasoningStrategy;
  /**
   * Cached probe verdict for `baseUrl|model`: `true` = mechanism respected,
   * `false` = silently ignored, `null` = probe has not run yet for this pair.
   */
  supported: boolean | null;
  /** Current `config.reasoning.mode` (default `"auto"` when unset). */
  mode: string;
}

/** Build the view from live config (entries win over legacy flat fields). */
export function buildReasoningView(config: AppConfig): ReasoningView {
  const endpoint = activeProviderEndpoint(config.provider);
  const spec = BUILTIN_PROVIDERS.find((p) => p.type === endpoint.type);
  const strategy = spec?.capabilities.reasoningStrategy ?? "none";
  const cached = getCachedProbeResult(`${endpoint.baseUrl}|${config.model}`);
  return {
    strategy,
    supported: cached === undefined ? null : cached,
    mode: config.reasoning?.mode ?? "auto",
  };
}
