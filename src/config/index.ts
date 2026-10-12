// Фасад конфига: дефолты, загрузка/сохранение, домены, типы, эксперты.
export { DEFAULTS } from "./defaults";
export { loadConfig, saveConfig, validateConfig, CONFIG_DIR, CONFIG_FILE, CONFIG_DOMAIN_DIR } from "./config";
export type { LoadConfigResult } from "./config";
export { getExpertConfig, validateExpertConfig } from "./experts";
export {
  CONFIG_DOMAINS,
  extractDomain,
  hasDomainFiles,
  loadDomainFiles,
  saveDomainFiles,
  getDomainFilePath,
  domainForKey,
} from "./domains";
export type {
  AppConfig,
  ProviderConfig,
  ContextBudget,
  ExpertConfig,
} from "./types";
