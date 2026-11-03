// Реестр: служебные ключи (уровень лога, локаль, версия установленного пакета).
import { readMmaVersion } from "../core/version";
import { LOCALES, LOG_LEVELS, type ConfigKeyDef } from "./registry-key-def";

export const META_DEFS: ConfigKeyDef[] = [
  {
    key: "logLevel",
    aliases: [],
    domain: "agent",
    valueType: "enum",
    enumValues: LOG_LEVELS,
    effects: [],
    get: (c) => c.logLevel,
    set: (c, v) => {
      c.logLevel = String(v);
    },
  },
  {
    key: "locale",
    aliases: [],
    domain: "i18n",
    valueType: "enum",
    enumValues: LOCALES,
    effects: ["i18n.reload"],
    get: (c) => c.locale,
    set: (c, v) => {
      c.locale = String(v);
    },
  },
  {
    key: "version",
    aliases: [],
    domain: "agent",
    valueType: "string",
    effects: [],
    readOnly: true,
    // Версия *установленного пакета*, а не `config.version` (то — версия схемы
    // конфига для детекта миграций, с релизом не совпадает никогда). Читается
    // в момент вызова, так что следует за обновлениями без рестарта.
    get: () => readMmaVersion(),
  },
];
