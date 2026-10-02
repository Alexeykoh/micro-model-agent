// Общий шаг «сохранить + переконфигурировать» для пишущих точек `mma web`.
/**
 * `config-api`, `providers-api` и `setup-api` несли идентичные инлайн-копии:
 * сначала персист, затем reconfigure, ни один провал не глотается (UI нужны
 * `persisted`/`warning`, чтобы отличить "сохранено" от "только в памяти").
 * Одна копия, тот же контракт.
 */
import type { AppConfig } from "../../../config/types";
import type { ConfigStore } from "../state";

/** Сначала персист, затем reconfigure; ни один провал не глотается. */
export async function persistAndReconfigure(
  s: ConfigStore,
  config: AppConfig,
): Promise<{ persisted: boolean; warning?: string }> {
  let persisted = true;
  let warning: string | undefined;
  try {
    s.saveConfig?.(config);
  } catch {
    persisted = false;
    warning = "config not persisted";
  }
  if (s.reconfigure) {
    try {
      await s.reconfigure(config);
    } catch {
      warning = warning ? `${warning}; reconfigure failed` : "reconfigure failed";
    }
  }
  const out: { persisted: boolean; warning?: string } = { persisted };
  if (warning) out.warning = warning;
  return out;
}
