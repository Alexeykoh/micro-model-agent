/**
 * `mma session diagnose <id> --json` — разбор сессии по сигнатурам (спека W5).
 *
 * Вынесено из `commands.ts`: каталог сессионных команд уже упирается в потолок
 * файла, а разбор — самостоятельный кусок поведения со своим контрактом вывода.
 */
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import type { SessionManager } from "../modules/session/manager";
import { diagnoseSession, type SIGNATURE_KINDS } from "../modules/session/diagnose";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { getDefaultChannel } from "../output";
import { fail } from "./exit-code";

/** Найти сессию по полному id, префиксу или имени — как это делает `export`. */
function resolveSession(manager: SessionManager, id: string) {
  return (
    manager.get(id) ??
    manager.list().find((s) => s.id.startsWith(id)) ??
    manager.list().find((s) => s.name.toLowerCase().includes(id.toLowerCase()))
  );
}

/** Подписи видов сигнатур; при новом виде строка обязана появиться здесь. */
const KIND_LABELS: Record<(typeof SIGNATURE_KINDS)[number], string> = {
  compaction_stall: "разбег компакции",
  prompt_block_dropped: "блок промпта не влез в бюджет",
  critic_degraded: "критик деградировал",
  tool_failure_repeat: "повторные падения тула",
  security_block_repeat: "повторная блокировка",
  claim_retry: "ход уходил в ретрай",
};

/**
 * Регистрирует `session diagnose`.
 *
 * `--json` — глобальный флаг программы (`-j, --json`), а не отдельная опция
 * подкоманды: commander не проверяет mandatory у опции, одноимённой глобальной,
 * и объявлять второй `--json` значило бы завести две разные галочки на один
 * флаг. Здесь он проверяется явно и с той же формулировкой, что у остальных
 * команд: формат вывода — контракт, а не украшение.
 */
export function registerDiagnoseCommand(session: Command, program: Command): void {
  session
    .command("diagnose")
    .argument("<id>", t("cli.session_id_or_prefix"))
    .description(t("cli.diagnose_session"))
    .addHelpText("after", `\n${t("cli.diagnose_json_help")}`)
    .action(async (id: string) => {
      if (program.opts<{ json?: boolean }>().json !== true) {
        // Отказ — не успех: иначе скрипт с `mma session diagnose` без --json
        // считает, что разбор выполнен (формат отчёта — контракт).
        fail(t("cli.diagnose_json_required"));
        return;
      }
      const { sessionManager } = await bootstrap();
      const meta = resolveSession(sessionManager, id);
      if (!meta) {
        fail(t("session.not_found", { id }));
        return;
      }
      const report = diagnoseSession(meta.id, sessionManager.loadSessionLog(meta.id) as unknown as Record<string, unknown>[]);

      if (report.signatures.length === 0) {
        getDefaultChannel().writeLine(t("diagnose.clean", { id: meta.id }));
        getDefaultChannel().writeLine(JSON.stringify(report, null, 2));
        return;
      }

      const channel = getDefaultChannel();
      channel.writeLine(
        pc.dim(
          t("diagnose.header", {
            id: meta.id,
            entries: report.entries,
            count: report.signatures.length,
          }),
        ),
      );
      for (const sig of report.signatures) {
        channel.writeLine(pc.yellow(`◇ ${KIND_LABELS[sig.kind]}`));
        channel.writeLine(`  ${t("diagnose.count", { count: sig.count })} — ${sig.detail}`);
        channel.writeLine(pc.dim(`  ${sig.first} … ${sig.last}`));
      }
      channel.writeLine(JSON.stringify(report, null, 2));
    });
}