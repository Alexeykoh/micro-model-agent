/**
 * Background model-list cache for `GET /api/models`.
 *
 * Split out of `module.ts` (rule #1: ≤300 lines/file). The endpoint is
 * synchronous but the provider call is not, so the list is refreshed once at
 * startup (best-effort) and again on every reconfigure — following the active
 * provider instead of going stale. An offline provider keeps the previous
 * list rather than failing.
 */
import type { Agent } from "../../core/agent";
import type { AppConfig } from "../../config/types";

export interface ModelCache {
  /** Live model ids (sorted); wired into `state.knownModels`. */
  get: () => string[];
  /** Refresh from the active provider; wired as the reconfigure hook. */
  refresh: () => Promise<void>;
}

export function makeModelCache(
  agent: Pick<Agent, "getProviderFor">,
  config: AppConfig,
): ModelCache {
  const cache: string[] = [];
  const refresh = async (): Promise<void> => {
    try {
      const name = config.provider.active || config.provider.entries?.[0]?.label || config.provider.type;
      const provider = agent.getProviderFor(name);
      if (!provider) return;
      const models = await provider.listModels();
      cache.splice(0, cache.length, ...models.slice().sort());
    } catch {
      // Offline provider: keep the previous list rather than failing.
    }
  };
  return { get: () => cache, refresh };
}
