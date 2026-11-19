/**
 * Host-поверхность web для конфига/моделей (split W3b): сборка трёх коллабораторов
 * `getConfig`/`setConfig`/`listModels` вынесена из `module.ts` (правило ≤300).
 */
import type { HostConfigSnapshot, HostConfigWriteResult, HostModels } from "../../../core/host";
import { serializeConfigForWire } from "../../../config/redact";
import { configVersion } from "../../../config/persist";
import { buildConfigRegistry } from "../../../runtime/config-view";
import { applyConfigWrite, toConfigRaw } from "../../../runtime/config-write";
import { setLocale } from "../../../i18n/index";
import type { AppConfig } from "../../../config/types";

/** Состояние, нужное для записи конфига и списка моделей. */
export interface HostConfigWiringState {
  saveConfig?: (config: AppConfig, key?: string) => void;
  reconfigure?: (config: AppConfig) => void | Promise<void>;
  knownModels?: () => string[];
  knownModelsFor?: (name: string) => { models: string[]; loading: boolean };
}

/** Возвращает `getConfig`/`setConfig`/`listModels` для `WebHost`. */
export function makeHostConfigWiring(
  config: AppConfig,
  state: HostConfigWiringState,
): {
  getConfig: () => HostConfigSnapshot;
  setConfig: (key: string, value: unknown) => Promise<HostConfigWriteResult>;
  listModels: (provider?: string) => HostModels;
} {
  return {
    getConfig: () => ({
      config: serializeConfigForWire(config),
      registry: buildConfigRegistry(config),
      version: configVersion(config),
    }),
    setConfig: async (key, value) => {
      const raw = toConfigRaw(value);
      if (raw === null) return { ok: false, persisted: false, error: "invalid-value" };
      const result = await applyConfigWrite(config, key, raw, {
        saveConfig: state.saveConfig,
        reconfigure: state.reconfigure,
      });
      if (result.ok && key === "locale") setLocale(config.locale);
      return result;
    },
    listModels: (provider?: string) => {
      if (provider && state.knownModelsFor) {
        const resolved = state.knownModelsFor(provider);
        return { models: resolved.models, loading: resolved.loading };
      }
      return { models: state.knownModels?.() ?? [] };
    },
  };
}
