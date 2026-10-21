// Общий шаг «сохранить + переконфигурировать» для пишущих точек `mma web`.
/**
 * `config-api`, `providers-api` и `setup-api` несли идентичные инлайн-копии:
 * сначала персист, затем reconfigure, ни один провал не глотается (UI нужны
 * `persisted`/`warning`, чтобы отличить "сохранено" от "только в памяти").
 * Одна копия, тот же контракт.
 */
import type { AppConfig } from "../../../config/types";
import type { ConfigStore, RuntimeState } from "../state";

/** Итог шага «сохранить + переконфигурировать». */
export interface PersistResult {
  persisted: boolean;
  warning?: string;
  /** true — запись отменена: ход начался, пока операция ждала. */
  busyConflict?: boolean;
}

/** Опции шага персиста. */
export interface PersistOptions {
  /**
   * Гейт занятости: если с момента начала операции стартовал ход (`busy`),
   * запись НЕ выполняется (аудит §7.9) — reconfigure живого раннера опасен.
   */
  guardBusy?: boolean;
}

/** Сначала персист, затем reconfigure; ни один провал не глотается. */
export async function persistAndReconfigure(
  s: ConfigStore & Partial<RuntimeState>,
  config: AppConfig,
  key?: string,
  opts: PersistOptions = {},
): Promise<PersistResult> {
  // TOCTOU: ход мог стартовать, пока мы ждали асинхронный проб.
  if (opts.guardBusy && s.busy) {
    return { persisted: false, warning: "busy", busyConflict: true };
  }
  let persisted = true;
  let warning: string | undefined;
  try {
    s.saveConfig?.(config, key);
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
  const out: PersistResult = { persisted };
  if (warning) out.warning = warning;
  return out;
}
