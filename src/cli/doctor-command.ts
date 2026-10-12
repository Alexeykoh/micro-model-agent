// `mma doctor` — сводная диагностика установки: окружение, модули (health),
// плагины, активный провайдер, LSP и конфиг. Сборка — `core/doctor.ts`.
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { buildDoctorReport, formatDoctorReport } from "../core/doctor";
import { getDefaultChannel } from "../output";
import { t } from "../i18n/index";

/** Регистрирует подкоманду `mma doctor`. */
export function createDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(t("cli.doctor"))
    .action(async () => {
      const boot = await bootstrap();
      const report = buildDoctorReport({
        config: boot.config,
        configDir: boot.configDir,
        baseDir: boot.baseDir,
        envReport: boot.envReport,
        moduleHost: boot.moduleHost,
        pluginManager: boot.pluginManager,
        lsp: boot.lspModule,
      });
      const channel = getDefaultChannel();
      for (const line of formatDoctorReport(report)) channel.writeLine(line);
    });
}
