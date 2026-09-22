import type { AppConfig } from "../config/types";
import type { SetupAnswers } from "./setup";

/** Extra commands added to the bash blacklist when the wizard enables it. */
const SECURITY_BASH_BLOCKLIST = [
  "rm",
  "dd",
  "chmod",
  "wget",
  "curl",
  "scp",
  "ssh",
  "nc",
  "netcat",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "shutdown",
  "reboot",
];

/**
 * Apply first-run wizard answers onto a loaded config.
 *
 * The provider is replaced with a **fresh object** rather than mutated in
 * place: `loadConfig` may register a session-scoped `MMA_PROVIDER_*` env
 * override whose `envValue` points at the loaded `config.provider` object.
 * `saveConfig`'s `stripEnvOverrides` then matches that object by identity and
 * would revert the whole provider to the env/default value, silently losing
 * the wizard's provider/URL/key. Replacing the object keeps the override's
 * stale identity intact, so only the env key is stripped and our answers are
 * persisted.
 */
export function applyAnswersToConfig(config: AppConfig, a: SetupAnswers): AppConfig {
  config.provider = {
    ...config.provider,
    type: a.provider,
    baseUrl: a.apiBase,
    apiKey: a.apiKey,
  };
  config.model = a.model;
  config.contextWindow = a.contextWindow;
  config.maxToolIterations = a.maxToolIterations;
  config.locale = a.locale;
  // Multi-entry configs resolve the active provider from `entries[]`, so the
  // answer must be written onto the active entry — without dropping the other
  // providers or the entry's tuning (contextWindow, cache, retry, rateLimits).
  if ((config.provider.entries?.length ?? 0) > 0) {
    const entries = config.provider.entries ?? [];
    const activeName =
      config.provider.active || entries[0]?.label || entries[0]?.type;
    const idx = entries.findIndex((e) => e.label === activeName || e.type === activeName);
    const target = idx >= 0 ? idx : 0;
    const updated = {
      ...entries[target],
      type: a.provider,
      label: a.provider,
      baseUrl: a.apiBase,
      apiKey: a.apiKey,
    };
    const next = entries.slice();
    next[target] = updated;
    config.provider.entries = next;
    config.provider.active = updated.label || updated.type;
  }
  if (config.security) {
    config.security.enabled = true;
    config.security.bash.enabled = true;
    config.security.bash.blockDangerousFlags =
      a.securityFlagsBlock || config.security.bash.blockDangerousFlags;
    if (a.securityBashBlock) {
      config.security.bash.blacklist = [
        ...new Set([...config.security.bash.blacklist, ...SECURITY_BASH_BLOCKLIST]),
      ];
    }
    config.security.paths.enabled = a.securityPathsRestrict;
    if (!a.securityPathsRestrict) config.security.paths.denied = [];
  }
  return config;
}
