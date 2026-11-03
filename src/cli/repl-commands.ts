// Slash-команды REPL: реестр, builtin и сборка групп.
// Правило 6: группы — в `repl-commands-*`: run, config, provider, context,
// agent( plugins/security/reload ), session, export, migrate, shared.
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { registerOnboardingCommands } from "./onboarding-commands";
import { registerLspCommands } from "./repl-commands-lsp";
import { registerSkillCommands } from "./repl-commands-skills";
import { registerDoctorCommands } from "./repl-commands-doctor";
import { registerRunCommands } from "./repl-commands-run";
import { registerConfigCommands } from "./repl-commands-config";
import { registerProviderCommands } from "./repl-commands-provider";
import { registerContextCommands } from "./repl-commands-context";
import { registerAgentCommands } from "./repl-commands-agent";
import { registerSessionCommands } from "./repl-commands-session";
import type { CommandContext } from "./command-context";

/** Slash-команда REPL: имя, описание, алиасы, usage и действие. */
export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
  /** Короткие рабочие примеры для `/help <команда>`. */
  examples?: string[];
  action(args: string[]): void | Promise<void>;
}

/**
 * Контекст REPL, пробрасываемый командам: сервисы + ввод/вывод.
 *
 * Разделён в `command-context.ts` на {@link CommandServices},
 * {@link CommandOutput} и {@link CommandInput}, чтобы TUI подключил тот же
 * реестр, реализовав две маленькие поверхности.
 */
export type ReplContext = CommandContext;

/**
 * Группы команд для `/help` больше не хранятся здесь: группа объявляется рядом
 * с описанием команды в общем каталоге (`src/core/commands/spec.ts`), а `/help`
 * группирует через `groupCommands`.
 */

/** Регистрирует все команды REPL (builtin + mma + онбординг + сессии + скиллы). */
export function registerAllCommands(ctx: ReplContext): void {
  registerBuiltinCommands(ctx);
  registerMmaCommands(ctx);
  registerOnboardingCommands(ctx);
  registerSessionCommands(ctx);
  registerSkillCommands(ctx);
  registerDoctorCommands(ctx);
}

function registerBuiltinCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "help",
    description: t("repl.help"),
    usage: t("repl.help_usage"),
    examples: ["/help", "/help config"],
    action: (args: string[]) => ctx.showHelp(args[0]),
  });
  ctx.registerCommand({
    name: "exit",
    description: t("repl.exit"),
    aliases: ["quit", "q"],
    usage: t("repl.exit_usage"),
    action: () => ctx.stop(),
  });
  ctx.registerCommand({
    name: "clear",
    description: t("repl.clear"),
    usage: t("repl.clear_usage"),
    action: () => {
      ctx.output.clearScreen();
      ctx.output.writeLine(pc.dim(t("repl.clear_hint")));
    },
  });
}

function registerMmaCommands(ctx: ReplContext): void {
  registerRunCommands(ctx);
  registerConfigCommands(ctx);
  registerProviderCommands(ctx);
  registerContextCommands(ctx);
  registerAgentCommands(ctx);
  registerLspCommands(ctx);
}
