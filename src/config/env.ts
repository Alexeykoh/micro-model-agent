/**
 * Единый реестр env-переменных `MMA_*`.
 *
 * Все обращения к окружению идут через `MMA_ENV`/`readEnv`, а не строковыми
 * литералами по коду: переименование правится в одном месте.
 */

/** Реестр имя→имя переменной окружения (константный). */
export const MMA_ENV = {
  CONFIG_DIR: "MMA_CONFIG_DIR",
  MODEL: "MMA_MODEL",
  PROVIDER_TYPE: "MMA_PROVIDER_TYPE",
  PROVIDER_BASEURL: "MMA_PROVIDER_BASEURL",
  PROVIDER_APIKEY: "MMA_PROVIDER_APIKEY",
  LOG_LEVEL: "MMA_LOG_LEVEL",
  LOCALE: "MMA_LOCALE",
  CONTEXT_WINDOW: "MMA_CONTEXT_WINDOW",
  MAX_TOOL_ITERATIONS: "MMA_MAX_TOOL_ITERATIONS",
  STUCK_THRESHOLD: "MMA_STUCK_THRESHOLD",
  AUTO_PLAN: "MMA_AUTO_PLAN",
  MOE_ENABLED: "MMA_MOE_ENABLED",
  CONTEXT_LOG: "MMA_CONTEXT_LOG",
  POST_SETUP: "MMA_POST_SETUP",
  START_MEET: "MMA_START_MEET",
  START_INIT: "MMA_START_INIT",
  WEBUI_PORT: "MMA_WEBUI_PORT",
  WEBUI_HOST: "MMA_WEBUI_HOST",
  WEBUI_TOKEN: "MMA_WEBUI_TOKEN",
  WEBUI_OPEN: "MMA_WEBUI_OPEN",
  WEBUI_MAX_CLIENTS: "MMA_WEBUI_MAX_CLIENTS",
  DSR: "MMA_DSR",
  MODELS_DEV_CACHE: "MMA_MODELS_DEV_CACHE",
  REASONING_CACHE: "MMA_REASONING_CACHE",
  CERT_HOME: "MMA_CERT_HOME",
  BROWSER_EXECUTABLE: "MMA_BROWSER_EXECUTABLE",
  BROWSER_CHANNEL: "MMA_BROWSER_CHANNEL",
  LSP_OFFLINE: "MMA_LSP_OFFLINE",
} as const;

/** Ключ реестра (семантическое имя переменной). */
export type MmaEnvKey = keyof typeof MMA_ENV;

/**
 * Читает переменную окружения в момент вызова (без кеширования): код и тесты
 * меняют/удаляют переменные в рантайме, значение обязано быть свежим.
 *
 * @param key семантическое имя из `MMA_ENV`;
 * @param env источник окружения (по умолчанию `process.env`).
 */
export function readEnv(key: MmaEnvKey, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[MMA_ENV[key]];
}
