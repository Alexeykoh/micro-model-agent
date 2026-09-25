/**
 * Shared first-run wizard data model.
 *
 * Consumed by both frontends (terminal `src/cli/setup.ts` and the browser
 * `mma web` wizard) so the collected shape and its defaults never diverge.
 * No terminal/UI dependencies — safe to import from the web server.
 */
import { BUILTIN_PROVIDERS } from "../providers/presets";

/** Everything the first-run wizard collects and `applyAnswersToConfig` writes. */
export interface SetupAnswers {
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxToolIterations: number;
  locale: string;
  securityBashBlock: boolean;
  securityFlagsBlock: boolean;
  securityPathsRestrict: boolean;
}

/** UI languages offered by the wizard (labels stay in their own language). */
export const SETUP_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
] as const;

/** Numeric defaults offered for the agent settings step. */
export const SETUP_DEFAULTS = {
  contextWindow: 32768,
  maxToolIterations: 1000,
} as const;

/** A provider selectable in the wizard (hosted presets carry a fixed URL). */
export interface SetupProviderOption {
  type: string;
  label: string;
  baseUrl?: string;
}

/** Display payload returned by `GET /api/setup` for the browser wizard. */
export interface SetupDisplay {
  languages: Array<{ value: string; label: string }>;
  providers: SetupProviderOption[];
  defaults: { contextWindow: number; maxToolIterations: number };
}

/** Resolve the static display data shared by the web wizard and its tests. */
export function buildSetupDisplay(): SetupDisplay {
  const providers: SetupProviderOption[] = BUILTIN_PROVIDERS.map((spec) => {
    const option: SetupProviderOption = { type: spec.type, label: spec.label };
    if (spec.baseUrl) option.baseUrl = spec.baseUrl;
    return option;
  });
  return {
    languages: SETUP_LANGUAGES.map((l) => ({ value: l.value, label: l.label })),
    providers,
    defaults: {
      contextWindow: SETUP_DEFAULTS.contextWindow,
      maxToolIterations: SETUP_DEFAULTS.maxToolIterations,
    },
  };
}
