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
    if (!a.securityPathsDeny) config.security.paths.denied = [];
  }
  return config;
}

/**
 * First-run orchestration: run the setup wizard BEFORE bootstrap so background
 * probes (context/reasoning) never start while the wizard owns the terminal.
 */
export async function order<TAnswers, TBoot>(opts: {
  hasConfig: boolean;
  interactive: boolean;
  runSetup: () => Promise<TAnswers | null>;
  applyAnswers?: (answers: TAnswers) => void;
  bootstrap: () => Promise<TBoot>;
}): Promise<{ answers: TAnswers | null; boot: TBoot }> {
  let answers: TAnswers | null = null;
  if (!opts.hasConfig && opts.interactive) {
    answers = await opts.runSetup();
    if (answers && opts.applyAnswers) opts.applyAnswers(answers);
  }
  const boot = await opts.bootstrap();
  return { answers, boot };
}
