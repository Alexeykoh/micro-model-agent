/**
 * Shared persist + reconfigure step for the `mma web` write endpoints.
 *
 * `config-api`, `providers-api` and `setup-api` used to carry identical
 * inline copies: persist first, then reconfigure, neither failure swallowed
 * (the UI needs `persisted`/`warning` to tell "saved" from "changed in memory
 * only"). One copy, same contract.
 */
import type { AppConfig } from "../../config/types";
import type { WebUiState } from "./state";

/** Persist first, then reconfigure; neither failure is swallowed. */
export async function persistAndReconfigure(
  s: WebUiState,
  config: AppConfig,
): Promise<{ persisted: boolean; warning?: string }> {
  let persisted = true;
  let warning: string | undefined;
  try {
    s.saveConfig?.(config);
  } catch {
    persisted = false;
    warning = "config not persisted";
  }
  if (s.reconfigure) {
    try {
      await s.reconfigure(config);
    } catch {
      warning = warning ? `${warning}; reconfigure failed` : "reconfigure failed";
    }
  }
  const out: { persisted: boolean; warning?: string } = { persisted };
  if (warning) out.warning = warning;
  return out;
}
