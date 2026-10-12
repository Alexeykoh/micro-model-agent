// INV-21 (W3.5): ключи конфига, объявленные модулями.
//
// Единый путь: модуль реализует `ModuleDef.configKeys()`, `ModuleHost` собирает
// их (`collectConfigKeys`) и на boot зовёт `registerConfigKeys`. Ядро не знает
// про модуль заранее — модуль сам приносит свою настройку, а не правит
// `registry-extra.ts` руками.
//
// Регистрация дописывает дефы в живой реестр `registry.ts` (`DEFINITIONS` +
// `BY_NAME`): так `configDefs()`/`canonicalKeys()`/`keysForGroup()`/
// `allConfigNames()`/`resolveConfigKey()` видят модульный ключ без правок. Это
// вынесено в отдельный файл, чтобы `registry.ts` (grandfathered, потолок строк)
// не рос.
import { BY_NAME, DEFINITIONS, type ConfigKeyDef } from "./registry";
import { Logger } from "../logger/app-logger";

const logger = new Logger("warn", "config");

/** Ключи, реально зарегистрированные из модулей (для идемпотентности/сброса). */
const REGISTERED: ConfigKeyDef[] = [];

/**
 * Регистрирует ключи, объявленные модулями (INV-21). Встроенные ключи
 * приоритетнее: коллизия по каноническому имени — предупреждение, декларация
 * модуля игнорируется (модуль не переопределяет ядро молча). Идемпотентно —
 * повторный bootstrap в том же процессе не плодит дубликаты.
 */
export function registerConfigKeys(defs: readonly ConfigKeyDef[]): void {
  for (const def of defs) {
    if (BY_NAME.has(def.key)) {
      logger.warn(`config key "${def.key}" already registered; module declaration ignored`);
      continue;
    }
    REGISTERED.push(def);
    DEFINITIONS.push(def);
    BY_NAME.set(def.key, def);
    for (const alias of def.aliases) {
      if (!BY_NAME.has(alias)) BY_NAME.set(alias, def);
    }
  }
}

/** Сброс модульных ключей (повторный bootstrap/тесты); встроенные остаются. */
export function __clearRegisteredConfigKeys(): void {
  for (const def of REGISTERED) {
    BY_NAME.delete(def.key);
    for (const alias of def.aliases) BY_NAME.delete(alias);
    const i = DEFINITIONS.indexOf(def);
    if (i >= 0) DEFINITIONS.splice(i, 1);
  }
  REGISTERED.length = 0;
}
