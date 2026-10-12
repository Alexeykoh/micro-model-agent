// `/doctor` — та же сводная диагностика, что `mma doctor`, в REPL.
import { buildDoctorReport, formatDoctorReport } from "../core/doctor";
import { getActiveModuleHost } from "../core/module-host";
import type { LspModule } from "../modules/lsp/module";
import type { ReplContext } from "./command-context";
import { t } from "../i18n/index";

/** Регистрирует `/doctor`: окружение, модули (health), плагины, провайдер, LSP, конфиг. */
export function registerDoctorCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "doctor",
    description: t("repl.doctor"),
    usage: t("repl.doctor_usage"),
    action: () => {
      const report = buildDoctorReport({
        config: ctx.config,
        configDir: ctx.configDir,
        baseDir: ctx.baseDir,
        envReport: ctx.envReport,
        moduleHost: getActiveModuleHost(),
        pluginManager: ctx.pluginManager,
        lsp: ctx.agent.getModule<LspModule>("lsp"),
      });
      for (const line of formatDoctorReport(report)) ctx.output.writeLine(line);
    },
  });
}
