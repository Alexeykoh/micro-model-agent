/**
 * `/context` — окно контекста и доли бюджета (system/reserve).
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { budgetBreakdownLines } from "../config/budget";
import { mutateConfig, renderConfigError } from "./config-mutations";
import { reportSaved } from "./repl-commands-shared";
import type { ReplContext } from "./repl-commands";

export function registerContextCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "context",
    description: t("cli.manage_context"),
    usage: t("repl.context_usage"),
    examples: ["/context", "/context 64000", "/context system 10%", "/context reserve 0.2"],
    action: async (args: string[]) => {
      if (args.length === 0) {
        for (const line of budgetBreakdownLines(ctx.config)) ctx.output.writeLine(line);
        ctx.output.writeLine(pc.dim(t("repl.context_usage")));
        return;
      }

      if (args[0] === "system" || args[0] === "reserve") {
        const raw = args[1];
        if (!raw) {
          ctx.output.writeLine(t("repl.context_usage"));
          return;
        }
        const key =
          args[0] === "system"
            ? "contextBudget.systemPrompt"
            : "contextBudget.responseReserve";
        const result = await mutateConfig(ctx, key, raw);
        if (!result.ok) {
          renderConfigError(ctx, result);
          return;
        }
        ctx.output.writeLine(
          pc.green(t("cli.context_fraction_set", { key: args[0], value: result.display })),
        );
        return;
      }

      if (!/^\d+$/.test(args[0])) {
        ctx.output.writeLine(pc.yellow(t("context.unknown_arg", { arg: args[0] })));
        ctx.output.writeLine(t("repl.context_usage"));
        return;
      }
      const result = await mutateConfig(ctx, "contextWindow", args[0]);
      if (!result.ok) {
        renderConfigError(ctx, result);
        return;
      }
      ctx.output.writeLine(pc.green(t("cli.context_set", { size: String(result.value) })));
      reportSaved(ctx, result);
    },
  });
}
