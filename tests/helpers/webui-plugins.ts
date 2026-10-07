// Стаб `WebPluginManager` для тестов веба: роли-подмножества PluginManager
// собираются вручную, поэтому нужен общий конструктор записей.
import type { PluginLoadFailure, PluginRecord } from "../../src/modules/plugins/records";

type RecordPatch = Partial<PluginRecord> & { name: string };

/**
 * Заглушка менеджера плагинов: `getRecords` + `getFailures` + живой `setEnabled`.
 * Состояние держится в замыкании, поэтому `setEnabled` реально переключает
 * записи — как в проде.
 */
export function stubPlugins(
  patches: RecordPatch[],
  failures: PluginLoadFailure[] = [],
): {
  getRecords: () => PluginRecord[];
  getFailures: () => PluginLoadFailure[];
  setEnabled: (name: string, on: boolean) => boolean;
} {
  const records: PluginRecord[] = patches.map((patch) => ({
    source: "global",
    builtin: false,
    draft: false,
    enabled: true,
    provides: { tools: [], hooks: [] },
    permissions: [],
    warnings: [],
    ...patch,
  }));
  return {
    getRecords: () => records.map((r) => ({ ...r })),
    getFailures: () => failures.map((f) => ({ ...f })),
    setEnabled: (name, on) => {
      const record = records.find((r) => r.name === name);
      if (!record) return false;
      record.enabled = on;
      return true;
    },
  };
}
