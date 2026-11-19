// Общий формат итога перезагрузки плагинов/навыков для CLI, REPL и веба.
//
// Сама перезагрузка живёт в классах-владельцах (`PluginManager.reload()` знает
// свои каталоги, `SkillsModule.reloadSources()` — свои), здесь только сборка
// строк: три поверхности должны показывать одно и то же.
import { t } from "../../i18n/index";

/** Итог, который умеют вернуть `PluginManager.reload()` и `SkillsModule`. */
export interface ReloadCounts {
  loaded: number;
  unloaded: number;
  failed: number;
  staleTs: number;
}

export interface SkillCounts {
  added: number;
  removed: number;
}

/** Строки итога. `staleTs > 0` означает «код .ts-плагина прежний, нужен рестарт». */
export function reloadSummaryLines(plugins: ReloadCounts, skills: SkillCounts): string[] {
  const lines = [
    t("plugin.reload_summary", {
      loaded: String(plugins.loaded),
      unloaded: String(plugins.unloaded),
      failed: String(plugins.failed),
    }),
  ];
  if (skills.added > 0 || skills.removed > 0) {
    lines.push(
      t("skill.reload_summary", { added: String(skills.added), removed: String(skills.removed) }),
    );
  }
  if (plugins.staleTs > 0) {
    lines.push(t("plugin.reload_stale_ts", { count: String(plugins.staleTs) }));
  }
  return lines;
}