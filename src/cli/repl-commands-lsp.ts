/**
 * Команда REPL `/lsp`: вынесена из `repl-commands.ts` (нарезка крупных файлов).
 */
import { pc } from "../ui/colors";
import { glyph } from "../ui/theme";
import { t } from "../i18n/index";
import { errMsg } from "../utils";
import type { LspModule } from "../modules/lsp/module";
import type {
  LspDiagnosis,
  LspFailureReason,
  LspServerDiagnosis,
} from "../modules/lsp/diagnose";
import type { ReplContext } from "./repl-commands";

/** i18n-ключ ярлыка класса причины. */
const REASON_KEY: Record<LspFailureReason, string> = {
  ok: "repl.lsp_reason_ok",
  disabled: "repl.lsp_reason_disabled",
  "not-applicable": "repl.lsp_reason_not_applicable",
  "binary-missing": "repl.lsp_reason_binary_missing",
  offline: "repl.lsp_reason_offline",
  network: "repl.lsp_reason_network",
  timeout: "repl.lsp_reason_timeout",
  "spawn-failed": "repl.lsp_reason_spawn_failed",
  "server-error": "repl.lsp_reason_server_error",
  deadline: "repl.lsp_reason_deadline",
};

/** Глиф и цвет строки сервера по классу причины (STYLE.md). */
function reasonStyle(reason: LspFailureReason): { g: string; color: (s: string) => string } {
  if (reason === "ok") return { g: glyph.success, color: pc.green };
  if (reason === "disabled" || reason === "not-applicable" || reason === "deadline") {
    return { g: "–", color: pc.dim };
  }
  return { g: glyph.failure, color: pc.red };
}

/** Какой detail показывать для класса причины. */
const DETAIL_KIND: Partial<Record<LspFailureReason, "binary" | "error">> = {
  "binary-missing": "binary",
  offline: "binary",
  network: "binary",
  "spawn-failed": "error",
  "server-error": "error",
};

/** Detail успешного сервера: время + способ запуска. */
function okDetail(s: LspServerDiagnosis): string {
  const via = s.useNpxFallback ? t("repl.lsp_via_npx") : t("repl.lsp_via_global");
  const secs = ((s.durationMs ?? 0) / 1000).toFixed(1);
  return `${secs}s · ${t("repl.lsp_via")} ${via}`;
}

/** Хвост-detail строки сервера (время, способ запуска, имя бинарника/ошибка). */
function serverDetail(s: LspServerDiagnosis): string {
  if (s.reason === "ok") return okDetail(s);
  const kind = DETAIL_KIND[s.reason];
  if (kind === "binary") return s.binaryName ?? s.command;
  if (kind === "error") return (s.error ?? "").split("\n")[0];
  return "";
}

/** Ключ actionable-подсказки по классу причины (timeout/лейбл — не подсказка). */
const HINT_KEY: Partial<Record<LspFailureReason, string>> = {
  "binary-missing": "lsp.hint_binary_missing",
  network: "lsp.hint_network",
  offline: "lsp.hint_offline",
  timeout: "lsp.hint_timeout",
  "spawn-failed": "lsp.hint_spawn",
  "server-error": "lsp.hint_spawn",
};

/** Actionable-подсказка под строкой сервера или null. */
function serverHint(reason: LspFailureReason): string | null {
  const key = HINT_KEY[reason];
  return key ? t(key) : null;
}

/** Отрисовать результат `/lsp doctor` строками (без боксов, по STYLE.md). */
function formatDoctor(diag: LspDiagnosis): string[] {
  const lines: string[] = [];
  const yes = (v: boolean, color: (s: string) => string) =>
    v ? color(t("repl.lsp_doctor_yes")) : pc.dim(t("repl.lsp_doctor_no"));
  lines.push(`  ${t("repl.lsp_doctor_enabled")} · ${yes(diag.enabled, pc.green)}`);
  lines.push(`  ${t("repl.lsp_doctor_offline")} · ${yes(diag.offline, pc.yellow)}`);
  lines.push(`  ${t("repl.lsp_doctor_project")} · ${diag.projectRoot}`);

  if (diag.servers.length === 0) {
    lines.push(pc.dim(`  ${t("repl.lsp_doctor_none")}`));
    return lines;
  }

  let actionable = false;
  for (const s of diag.servers) {
    const { g, color } = reasonStyle(s.reason);
    const detail = serverDetail(s);
    const suffix = detail ? pc.dim(` · ${detail}`) : "";
    lines.push(`  ${color(g)} ${s.language} · ${color(t(REASON_KEY[s.reason]))}${suffix}`);
    const hint = serverHint(s.reason);
    if (hint) {
      lines.push(pc.dim(`      ${glyph.detail} ${hint}`));
      if (s.reason !== "timeout") actionable = true;
    }
    if (s.installCommand) {
      lines.push(pc.dim(`      ${glyph.detail} ${t("repl.lsp_install", { command: s.installCommand })}`));
      actionable = true;
    }
  }
  if (actionable || diag.offline) {
    lines.push(pc.dim(`  ${glyph.detail} ${t("repl.lsp_doctor_hint")}`));
  }
  return lines;
}

/** Регистрирует `/lsp` (status/restart/check) через handler-map (правило #17). */
export function registerLspCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "lsp",
    description: t("repl.lsp"),
    usage: t("repl.lsp_usage"),
    examples: ["/lsp status", "/lsp restart", "/lsp check src/index.ts"],
    action: async (args: string[]) => {
      // Доступ к LSP-модулю через реестр модулей агента.
      const lspModule = ctx.agent.getModule<LspModule>("lsp");
      if (!lspModule) {
        ctx.output.writeLine(pc.yellow(t("repl.lsp_not_available")));
        return;
      }

      const handlers: Record<string, (rest: string[]) => void | Promise<void>> = {
        status: () => {
          const disabled = lspModule.getDisabledServers();
          const failures = lspModule.getFailureCounts();
          const config = ctx.config.lsp;

          ctx.output.writeLine(pc.bold(t("repl.lsp_status_header")));
          ctx.output.writeLine(
            `${t("repl.lsp_enabled")} ${config?.enabled ? pc.green(t("repl.yes")) : pc.red(t("repl.no"))}`,
          );
          // Тёплые соединения пула: до 2.39 сервер умирал после каждой проверки.
          const pool = lspModule.poolStats();
          ctx.output.writeLine(
            pc.dim(`${t("repl.lsp_pool")} ${pool.live} · ${t("repl.lsp_pool_reaped")} ${pool.reaped} · ${t("repl.lsp_pool_restarts")} ${pool.restarts}`),
          );

          if (disabled.length > 0) {
            ctx.output.writeLine(
              pc.yellow(`${t("repl.lsp_disabled_servers")} ${disabled.join(", ")}`),
            );
          }

          if (failures.size > 0) {
            ctx.output.writeLine(pc.dim(t("repl.lsp_failure_counts")));
            for (const [server, count] of failures) {
              ctx.output.writeLine(pc.dim(`  ${server}: ${count}`));
            }
          }

          if (disabled.length === 0 && failures.size === 0) {
            ctx.output.writeLine(pc.green(t("repl.lsp_all_ok")));
          }
        },

        restart: () => {
          ctx.output.writeLine(pc.yellow(t("repl.lsp_restarting")));
          lspModule.resetDisabledServers();
          ctx.output.writeLine(pc.green(t("repl.lsp_restarted")));
        },

        doctor: async () => {
          ctx.output.writeLine(pc.bold(t("repl.lsp_doctor_header")));
          const diag = await lspModule.diagnose(ctx.baseDir);
          for (const line of formatDoctor(diag)) ctx.output.writeLine(line);
        },

        check: async (rest: string[]) => {
          const path = rest[0];
          if (!path) {
            ctx.output.writeLine(pc.yellow(t("repl.lsp_check_usage")));
            return;
          }
          ctx.output.writeLine(pc.dim(t("repl.lsp_checking", { path })));
          // Запуск тула lsp_check через публичный API агента (не через приватные deps)
          try {
            const result = await ctx.agent.runTool("lsp_check", { path });
            if (result?.output) {
              ctx.output.writeLine(result.output);
            }
          } catch (e) {
            ctx.output.writeLine(pc.red(t("repl.lsp_check_error", { error: errMsg(e) })), "stderr");
          }
        },
      };

      const subcommand = args[0] || "status";
      const handler = handlers[subcommand];
      if (!handler) {
        ctx.output.writeLine(
          pc.yellow(t("repl.unknown_sub", { cmd: "lsp", sub: subcommand })),
        );
        ctx.output.writeLine(pc.dim(t("repl.lsp_usage")));
        return;
      }
      await handler(args.slice(1));
    },
  });
}
