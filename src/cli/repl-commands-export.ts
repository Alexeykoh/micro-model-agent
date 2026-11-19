/**
 * `/export` — выгрузка сессии в md/json/jsonl с редакцией и записью в файл.
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { errMsg } from "../utils";
import {
  formatExport,
  redactExport,
  sanitizeFileName,
  extensionFor,
  type ExportFormat,
} from "../modules/session/export";
import { join, dirname } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { globalExportsDir } from "../config/paths";
import type { ReplContext } from "./repl-commands";

export function registerSessionExportCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "export",
    description: t("repl.export"),
    usage: t("repl.export_usage"),
    examples: [
      "/export",
      "/export my-session --format md",
      "/export --format json --out -",
    ],
    action: async (args: string[]) => {
      let format: ExportFormat = "md";
      let out: string | undefined;
      let redact = true;
      let compact = false;
      const positional: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--format") {
          const v = args[++i];
          if (!v) {
            ctx.output.writeLine(t("export.missing_value", { flag: a }));
            return;
          }
          format = v as ExportFormat;
        } else if (a === "--out") {
          const v = args[++i];
          if (v === undefined) {
            ctx.output.writeLine(t("export.missing_value", { flag: a }));
            return;
          }
          out = v;
        } else if (a === "--no-redact") {
          redact = false;
        } else if (a === "--compact") {
          compact = true;
        } else {
          positional.push(a);
        }
      }
      if (format !== "md" && format !== "json" && format !== "jsonl") {
        ctx.output.writeLine(pc.yellow(t("export.invalid_format", { format })), "stderr");
        return;
      }
      const query = positional.join(" ");
      const sessions = ctx.sessionManager!.list();
      const match = query
        ? sessions.find(
            (s) =>
              s.id === query ||
              s.id.startsWith(query) ||
              s.name.toLowerCase().includes(query.toLowerCase()),
          )
        : sessions.find((s) => s.id === ctx.sessionManager!.getActive());
      if (!match) {
        ctx.output.writeLine(
          query ? t("session.no_match", { query }) : t("session.no_active"),
        );
        return;
      }
      const messages = ctx.sessionManager!.getHistory(match.id);
      const log = ctx.sessionManager!.loadSessionLog(match.id);
      if (format === "jsonl" ? log.length === 0 : messages.length === 0) {
        ctx.output.writeLine(pc.yellow(t("export.empty")));
        return;
      }
      const text = redactExport(
        formatExport({ meta: match, messages, log }, format, { compact }),
        redact,
      );
      if (out === "-") {
        ctx.output.writeLine(text);
        return;
      }
      const baseDir = out ? dirname(out) : globalExportsDir();
      const path =
        out ?? join(baseDir, `${sanitizeFileName(match.name)}-${match.id.slice(0, 8)}.${extensionFor(format)}`);
      try {
        mkdirSync(baseDir, { recursive: true });
        writeFileSync(path, text, "utf-8");
      } catch (e) {
        ctx.output.writeLine(pc.red(t("export.write_failed", { error: errMsg(e) })), "stderr");
        return;
      }
      ctx.output.writeLine(pc.green(t("export.written", { path })));
      ctx.output.writeLine(pc.dim(redact ? t("export.redacted") : t("export.raw")));
    },
  });
}
