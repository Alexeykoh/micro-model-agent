// Slash-команды сессий: list / show / export / delete / prune.
//
// Вынесено из `commands.ts`: у сессий своя политика (резолв id по префиксу
// и имени, коды возврата), и общий файл команд от неё не должен расти
// (правило 6 AGENTS).
import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { bootstrap } from "../core/bootstrap";
import { getDefaultChannel, setLogsToStderr } from "../output";
import { globalExportsDir } from "../config/paths";
import {
  extensionFor,
  formatExport,
  redactExport,
  sanitizeFileName,
  type ExportFormat,
} from "../modules/session/export";
import { registerDiagnoseCommand } from "./session-diagnose-command";
import { fail } from "./exit-code";

/** Резолв сессии: точный id, префикс id или вхождение в имя. */
function resolveSession(
  sessionManager: Awaited<ReturnType<typeof bootstrap>>["sessionManager"],
  id: string,
): ReturnType<typeof sessionManager.get> | undefined {
  return (
    sessionManager.get(id) ??
    sessionManager.list().find((s) => s.id.startsWith(id)) ??
    sessionManager.list().find((s) => s.name.toLowerCase().includes(id.toLowerCase()))
  );
}

/** Команды `mma session …`. */
export function buildSessionCommands(program: Command): void {
  const session = program.command("session").description(t("cli.manage_sessions"));
  session
    .command("list")
    .description(t("cli.list_sessions"))
    .action(async () => {
      const { sessionManager } = await bootstrap();
      const sessions = sessionManager.list();
      if (sessions.length === 0) {
        getDefaultChannel().writeLine(t("session.no_sessions"));
        return;
      }
      const active = sessionManager.getActive();
      for (const s of sessions) {
        const marker = s.id === active ? "*" : " ";
        getDefaultChannel().writeLine(
          ` ${marker} ${s.id.slice(0, 12)}  ${s.name}  ${s.messageCount} ${t("repl.msgs")}  ${s.updatedAt.slice(0, 10)}`,
        );
      }
    });
  session
    .command("show")
    .argument("<id>", t("cli.session_id"))
    .description(t("cli.show_details"))
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap();
      const meta = sessionManager.get(id);
      if (!meta) {
        fail(t("session.not_found", { id }));
        return;
      }
      getDefaultChannel().writeLine(`${t("cli.session_field_id")}           ${meta.id}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_name")}         ${meta.name}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_created")}      ${meta.createdAt}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_updated")}      ${meta.updatedAt}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_messages")}     ${meta.messageCount}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_model")}        ${meta.model}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_context")}      ${meta.contextWindow}`);
      getDefaultChannel().writeLine(`${t("cli.session_field_project")}      ${meta.projectDir}`);

      const usageEvents = sessionManager.loadSessionLog(id).filter((e) => e.type === "llm_usage");
      if (usageEvents.length > 0) {
        let prompt = 0;
        let completion = 0;
        let cached = 0;
        for (const e of usageEvents) {
          prompt += e.promptTokens ?? 0;
          completion += e.completionTokens ?? 0;
          cached += e.cachedTokens ?? 0;
        }
        getDefaultChannel().writeLine("");
        getDefaultChannel().writeLine(
          pc.cyan(
            t("cli.session_usage", {
              prompt,
              completion,
              total: prompt + completion,
            }),
          ),
        );
        if (cached > 0 && prompt > 0) {
          const hit = Math.round((cached / prompt) * 100);
          getDefaultChannel().writeLine(
            pc.dim(
              t("cli.session_cache", {
                hit,
                cached,
                uncached: Math.max(0, prompt - cached),
              }),
            ),
          );
        }
      }
    });
  session
    .command("export")
    .argument("<id>", t("cli.session_id_or_prefix"))
    .description(t("cli.export_session"))
    .option("--format <format>", t("cli.export_format"), "md")
    .option("--out <path>", t("cli.export_out"))
    .option("--no-redact", t("cli.export_no_redact"))
    .option("--compact", t("cli.export_compact"))
    .action(async (id: string, opts: { format: string; out?: string; redact: boolean; compact?: boolean }) => {
      // `--out -` — машинный документ в stdout: диагностику старта (WARN о
      // бюджете промпта и т. п.) уводим в stderr, иначе пайп `| jq` ломается.
      if (opts.out === "-") setLogsToStderr(true);
      const { sessionManager } = await bootstrap();
      const meta = resolveSession(sessionManager, id);
      if (!meta) {
        fail(t("session.not_found", { id }));
        return;
      }
      const format = opts.format as ExportFormat;
      if (format !== "md" && format !== "json" && format !== "jsonl") {
        fail(t("export.invalid_format", { format }));
        return;
      }
      const messages = sessionManager.getHistory(meta.id);
      const log = sessionManager.loadSessionLog(meta.id);
      if (format === "jsonl" ? log.length === 0 : messages.length === 0) {
        getDefaultChannel().writeLine(t("export.empty"));
        return;
      }
      const text = redactExport(
        formatExport({ meta, messages, log }, format, { compact: opts.compact }),
        opts.redact,
      );
      if (opts.out === "-") {
        getDefaultChannel().writeLine(text);
        return;
      }
      const baseDir = opts.out ? dirname(opts.out) : globalExportsDir();
      const path =
        opts.out ??
        join(
          baseDir,
          `${sanitizeFileName(meta.name)}-${meta.id.slice(0, 8)}.${extensionFor(format)}`,
        );
      try {
        mkdirSync(baseDir, { recursive: true });
        writeFileSync(path, text, "utf-8");
      } catch (e) {
        fail(t("export.write_failed", { error: String(e) }));
        return;
      }
      getDefaultChannel().writeLine(t("export.written", { path }));
      getDefaultChannel().writeLine(t(opts.redact ? "export.redacted" : "export.raw"));
    });
  session
    .command("delete")
    .argument("<id>", t("cli.session_id"))
    .description(t("cli.delete_session"))
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap();
      // Резолвим префикс/имя, как в `session export`: иначе удаление чужой
      // сессии молча ничего не делало, а скрипт видел успех (аудит §7.3).
      const meta = resolveSession(sessionManager, id);
      if (!meta) {
        fail(t("session.not_found", { id }));
        return;
      }
      sessionManager.delete(meta.id);
      getDefaultChannel().writeLine(t("session.deleted", { id: meta.id }));
    });
  registerDiagnoseCommand(session, program);
  session
    .command("prune")
    .description(t("cli.prune_sessions"))
    .option("--dry-run", t("cli.prune_dry_run"))
    .action(async (opts: { dryRun?: boolean }) => {
      const { sessionManager } = await bootstrap();
      const active = sessionManager.getActive();
      const candidates = sessionManager
        .list()
        .filter((s) => s.id !== active && sessionManager.isEmptySession(s.id));
      if (candidates.length === 0) {
        getDefaultChannel().writeLine(t("session.prune_empty"));
        return;
      }
      if (opts.dryRun) {
        getDefaultChannel().writeLine(t("session.prune_dry", { n: candidates.length }));
      } else {
        const deleted = sessionManager.pruneEmpty(active ?? undefined);
        getDefaultChannel().writeLine(t("session.pruned", { n: deleted.length }));
      }
      for (const s of candidates) {
        getDefaultChannel().writeLine(`   ${s.id.slice(0, 12)}  ${s.name}`);
      }
    });
}
