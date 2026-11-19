/**
 * Запись одного ключа конфига для поверхностей (split W3b).
 *
 * Один путь: валидация реестром → персист тронутого домена → reconfigure,
 * если эффекты этого требуют. Web, REPL и host wire используют эту функцию,
 * чтобы «применить значение» не расходилось по трём копиям.
 */
import type { AppConfig } from "../config/types";
import { setConfigValue } from "../config/registry";
import { needsRebuild } from "../config/effects";

/** Хуки поверхности: как сохранить и как пересобрать живой рантайм. */
export interface ConfigWriteHooks {
  saveConfig?: (config: AppConfig, key?: string) => void;
  reconfigure?: (config: AppConfig) => void | Promise<void>;
}

/** Итог записи ключа. */
export interface ConfigWriteResult {
  ok: boolean;
  value?: unknown;
  display?: string;
  persisted: boolean;
  warning?: string;
  error?: string;
  effects?: readonly string[];
}

/** Коэрсит JSON-значение в сырую строку; объекты/массивы не поддержаны. */
export function toConfigRaw(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Применяет `Raw`-значение ключа: валидация, персист, при необходимости reconfigure. */
export async function applyConfigWrite(
  config: AppConfig,
  key: string,
  raw: string,
  hooks: ConfigWriteHooks,
): Promise<ConfigWriteResult> {
  const result = setConfigValue(config, key, raw);
  if (!result.ok) return { ok: false, persisted: false, error: result.reason };

  let persisted = true;
  let warning: string | undefined;
  if (!hooks.saveConfig) {
    persisted = false;
    warning = "config not persisted";
  } else {
    try {
      hooks.saveConfig(config, key);
    } catch {
      persisted = false;
      warning = "config not persisted";
    }
  }

  if (needsRebuild(result.effects)) {
    if (!hooks.reconfigure) {
      warning = warning ? `${warning}; reconfigure unavailable` : "reconfigure unavailable";
    } else {
      try {
        await hooks.reconfigure(config);
      } catch {
        warning = warning ? `${warning}; reconfigure failed` : "reconfigure failed";
      }
    }
  }

  return {
    ok: true,
    value: result.value,
    display: result.display,
    persisted,
    ...(warning ? { warning } : {}),
    effects: result.effects,
  };
}
