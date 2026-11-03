import type { AppConfig, ProviderEntry } from "./types";
import { MMA_ENV } from "./env";

export interface EnvOverride {
  key: string;
  envValue: unknown;
  originalValue: unknown;
}

/**
 * Применяет MMA_*-оверрайды окружения. Возвращает тронутые ключи с ДО-env
 * значениями, чтобы `saveConfig` не персистил сессионные env-значения (C4).
 */
export function applyEnvVars(config: AppConfig): { config: AppConfig; overrides: EnvOverride[] } {
  const env = process.env;
  const overrides: EnvOverride[] = [];
  const result = { ...config };

  const record = (key: string, envValue: unknown): void => {
    const original = (result as unknown as Record<string, unknown>)[key];
    if (original !== envValue) overrides.push({ key, envValue, originalValue: original });
  };

  if (env[MMA_ENV.MODEL]) {
    record("model", env[MMA_ENV.MODEL]);
    result.model = env[MMA_ENV.MODEL]!;
  }

  const originalProvider = result.provider;

  // normalizeEntries предпочитает entries[] и игнорит плоские поля провайдера, так
  // что плоский env-оверрайд на мультиконфиге — тихий no-op (а cert-харнесс зависит
  // от работы этих vars). Резолвим активную запись и патчим её тоже.
  const activeEntryIndex = ((): number => {
    const entries = result.provider.entries;
    if (!entries || entries.length === 0) return -1;
    const active = result.provider.active;
    if (!active) return 0;
    const i = entries.findIndex((e) => e.label === active || e.type === active);
    return i >= 0 ? i : 0;
  })();

  const patchActiveEntry = (patch: Partial<ProviderEntry>): void => {
    if (activeEntryIndex < 0) return;
    const entries = result.provider.entries!;
    const next = [...entries];
    next[activeEntryIndex] = { ...next[activeEntryIndex], ...patch };
    result.provider = { ...result.provider, entries: next };
  };

  if (env[MMA_ENV.PROVIDER_TYPE]) {
    result.provider = { ...result.provider, type: env[MMA_ENV.PROVIDER_TYPE]! };
    patchActiveEntry({ type: env[MMA_ENV.PROVIDER_TYPE]! });
  }
  if (env[MMA_ENV.PROVIDER_BASEURL]) {
    result.provider = { ...result.provider, baseUrl: env[MMA_ENV.PROVIDER_BASEURL]! };
    patchActiveEntry({ baseUrl: env[MMA_ENV.PROVIDER_BASEURL]! });
  }
  if (env[MMA_ENV.PROVIDER_APIKEY]) {
    result.provider = { ...result.provider, apiKey: env[MMA_ENV.PROVIDER_APIKEY]! };
    patchActiveEntry({ apiKey: env[MMA_ENV.PROVIDER_APIKEY]! });
  }
  if (env[MMA_ENV.PROVIDER_TYPE] || env[MMA_ENV.PROVIDER_BASEURL] || env[MMA_ENV.PROVIDER_APIKEY]) {
    // Пишем один раз с ФИНАЛЬНЫМ env-мутированным объектом провайдера, чтобы
    // identity-проверка в stripEnvOverrides сошлась с загруженным конфигом.
    overrides.push({ key: "provider", envValue: result.provider, originalValue: originalProvider });
  }
  if (env[MMA_ENV.LOG_LEVEL]) {
    record("logLevel", env[MMA_ENV.LOG_LEVEL]);
    result.logLevel = env[MMA_ENV.LOG_LEVEL]!;
  }
  if (env[MMA_ENV.LOCALE]) {
    record("locale", env[MMA_ENV.LOCALE]);
    result.locale = env[MMA_ENV.LOCALE]!;
  }
  if (env[MMA_ENV.CONTEXT_WINDOW]) {
    const v = parseInt(env[MMA_ENV.CONTEXT_WINDOW]!, 10);
    if (!Number.isNaN(v)) {
      record("contextWindow", v);
      result.contextWindow = v;
    }
  }
  if (env[MMA_ENV.MAX_TOOL_ITERATIONS]) {
    const v = parseInt(env[MMA_ENV.MAX_TOOL_ITERATIONS]!, 10);
    if (!Number.isNaN(v)) {
      record("maxToolIterations", v);
      result.maxToolIterations = v;
    }
  }
  if (env[MMA_ENV.STUCK_THRESHOLD]) {
    const v = parseInt(env[MMA_ENV.STUCK_THRESHOLD]!, 10);
    if (!Number.isNaN(v)) {
      record("stuckThreshold", v);
      result.stuckThreshold = v;
    }
  }
  if (env[MMA_ENV.AUTO_PLAN]) {
    const v = env[MMA_ENV.AUTO_PLAN] === "true";
    record("autoPlan", v);
    result.autoPlan = v;
  }
  if (env[MMA_ENV.CONTEXT_LOG]) {
    const next = { ...result.contextLog, enabled: env[MMA_ENV.CONTEXT_LOG] !== "false" };
    record("contextLog", next);
    result.contextLog = next;
  }

  return { config: result, overrides };
}

/** До-env значения env-тронутых ключей, по объекту загруженного конфига. */
const envOverrideMap = new WeakMap<AppConfig, EnvOverride[]>();

/**
 * Возвращает до-env значения перед сохранением: сессионные env-оверрайды
 * (например, baseUrl cert-харнесса) НЕ должны протекать в файлы доменов. Явное
 * позднее изменение (setProvider/reconfigure заменил provider, /model use)
 * видно как другой объект/значение и сохраняется как есть.
 */
export function stripEnvOverrides(config: AppConfig): AppConfig {
  const overrides = envOverrideMap.get(config);
  if (!overrides || overrides.length === 0) return config;
  const result = { ...config };
  for (const o of overrides) {
    const rec = result as unknown as Record<string, unknown>;
    if (rec[o.key] === o.envValue) {
      rec[o.key] = o.originalValue;
    }
  }
  return result;
}

// ── Публичное API ─────────────────────────────────────────────────────────

/** Опции загрузки: глобальный каталог и путь проектного конфига. */
/** Remembers which env vars were applied so a save does not persist them. */
export function rememberEnvOverrides(config: AppConfig, overrides: EnvOverride[]): void {
  envOverrideMap.set(config, overrides);
}
