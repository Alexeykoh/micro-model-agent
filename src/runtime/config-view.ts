/**
 * Представление конфига для wire (split W3b): реестр ключей + сериализация.
 *
 * Живёт в нейтральном runtime-слое, потому что читают и web, и host wire;
 * правая часть (`ConfigKeyDef`) остаётся единственным источником правды.
 */
import { configDefs, type ConfigKeyDef } from "../config/registry";
import type { AppConfig } from "../config/types";

/** Запись реестра для UI настроек / тонкого клиента. */
export interface ConfigRegistryEntry {
  key: string;
  aliases: string[];
  valueType: string;
  group: string;
  enum?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  readOnly?: boolean;
  value?: unknown;
  editor?: ConfigKeyDef["editor"];
}

/** Сериализует реестр в порядке реестра (только канонические ключи). */
export function buildConfigRegistry(config?: AppConfig): ConfigRegistryEntry[] {
  return configDefs().map((def) => {
    const entry: ConfigRegistryEntry = {
      key: def.key,
      aliases: def.aliases,
      valueType: def.valueType,
      group: def.domain,
    };
    if (def.enumValues) entry.enum = def.enumValues;
    if (def.min !== undefined) entry.min = def.min;
    if (def.max !== undefined) entry.max = def.max;
    if (def.step !== undefined) entry.step = def.step;
    if (def.readOnly) {
      entry.readOnly = true;
      if (config) entry.value = def.get(config);
    }
    if (def.editor) entry.editor = def.editor;
    return entry;
  });
}
