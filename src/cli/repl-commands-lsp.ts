/**
 * Команда REPL `/lsp`: вынесена из `repl-commands.ts` (нарезка крупных файлов).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { errMsg } from "../utils";
import type { LspModule } from "../modules/lsp/module";
import type { ReplContext } from "./repl-commands";

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
