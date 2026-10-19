/**
 * Скрытые от API пути (`security.dataPolicy.apiHiddenGlobs`, D2/INV-D6).
 * Kill-switch уважается: при `dataPolicy.enabled:false` ничего не скрываем.
 */
import type { AppConfig } from "../../../config/types";

/** Узкий вход файловых роутов: workspace + живой конфиг (без composed state). */
export interface PathPolicyStore {
  workspace?: string;
  config?: AppConfig;
}

/** Активный glob-список скрытых путей (пустой, если политика выключена). */
export function apiHiddenGlobs(config: AppConfig | undefined): string[] {
  const dp = config?.security?.dataPolicy;
  if (!dp || dp.enabled === false) return [];
  return dp.apiHiddenGlobs;
}
