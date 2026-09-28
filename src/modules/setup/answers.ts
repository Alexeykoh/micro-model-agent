// Модель данных first-run визарда: ответы, языки, дефолты, провайдеры для UI.
/**
 * Общая модель данных first-run визарда.
 * Едят оба фронтенда (терминальный `src/cli/setup.ts` и браузерный визард
 * `mma web`), чтобы форма и дефолты не расходились. Без терминальных/UI
 * зависимостей — безопасно импортить с веб-сервера.
 */
import { BUILTIN_PROVIDERS } from "../providers/presets";

/** Всё, что собирает first-run визард и пишет `applyAnswersToConfig`. */
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

/** Языки UI визарда (подписи — на своём языке). */
export const SETUP_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
] as const;

/** Числовые дефолты шага настроек агента. */
export const SETUP_DEFAULTS = {
  contextWindow: 32768,
  maxToolIterations: 1000,
} as const;

/** Провайдер на выбор в визарде (у хостед-пресетов фиксированный URL). */
export interface SetupProviderOption {
  type: string;
  label: string;
  baseUrl?: string;
}

/** Display-пейлоад `GET /api/setup` для браузерного визарда. */
export interface SetupDisplay {
  languages: Array<{ value: string; label: string }>;
  providers: SetupProviderOption[];
  defaults: { contextWindow: number; maxToolIterations: number };
}

/** Статические display-данные, общие для веб-визарда и его тестов. */
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
