// Commander-программа: фабрика createProgram и one-shot-выход; сами команды —
// в per-domain builder-модулях `cli/*-commands.ts`.
import { Command } from "commander";
import { t } from "../i18n/index";
import { buildSessionCommands } from "./session-commands";
import { createSecurityCommand } from "./security-commands";
import { createPluginCommand } from "./plugin-commands";
import { createDoctorCommand } from "./doctor-command";
import { readMmaVersion } from "../core/version";
import { currentExitCode } from "./exit-code";
import {
  buildAgentsCommand,
  buildInitCommand,
  buildMeetCommand,
  buildServeCommand,
  buildSetupCommand,
  buildWebCommand,
} from "./setup-commands";
import { buildConfigCommands, buildContextCommand } from "./config-commands";
import { buildModelCommands } from "./model-commands";
import { buildProviderCommands } from "./provider-commands";
import { buildChangelogCommand, buildMapCommand, buildUsageCommand } from "./info-commands";

export { configForDisplay } from "./config-commands";

const version = readMmaVersion();

/** Тонкий оркестратор: собирает CLI из per-domain builder-функций. */
export function createProgram(): Command {
  const program = new Command()
    .name("mma")
    .description(t("cli.description"))
    .version(version)
    .option("--no-agents-md", t("cli.no_agents_md"))
    .option("-d, --dir <path>", t("cli.dir"))
    .option("-e, --exit-on-complete", t("cli.exit_on_complete"))
    .option("-j, --json", t("cli.json"))
    .option("--reasoning <level>", t("cli.reasoning_level"), "auto")
    .option("--verbose", t("cli.verbose"))
    .option("--context-log", t("cli.context_log"));

  buildSetupCommand(program);
  buildMeetCommand(program);
  buildInitCommand(program);
  buildAgentsCommand(program);
  buildWebCommand(program);
  buildServeCommand(program);
  buildConfigCommands(program);
  buildModelCommands(program);
  buildContextCommand(program);
  buildUsageCommand(program);
  buildMapCommand(program);
  buildProviderCommands(program);
  buildSessionCommands(program);

  createSecurityCommand(program);
  createPluginCommand(program);
  createDoctorCommand(program);

  buildChangelogCommand(program);

  program
    .argument("[prompt...]", t("cli.prompt_arg"))
    .description(t("cli.run_prompt"))
    .action((_prompt: string[]) => {
      /* Обрабатывает main.ts после program.parse(). */
    });

  // Экшены субкоманд гонят полный bootstrap() (reasoning-пробник, индексер,
  // плагины…), оставляющий открытые хендлы: без явного exit процесс висит.
  // Prompt/REPL-пути выходят явно в main.ts; каждая СУБКОМАНДА — one-shot.
  //
  // Хук навешиваем РЕКУРСИВНО на все подкоманды: у вложенных (`session show`,
  // `model certify`, `provider use` …) родитель без action, поэтому postAction
  // родителя не срабатывает и фоновые хендлы держат процесс — «виснет».
  // На `program` хук не вешаем: его action — prompt/REPL под управлением main.ts.
  const attachOneShotExit = (cmd: Command): void => {
    cmd.hook("postAction", () => {
      // Код возврата — из fail(): ошибка команды должна быть видна скрипту.
      process.exit(currentExitCode());
    });
    for (const sub of cmd.commands) attachOneShotExit(sub);
  };
  // `meet`/`agents` — не one-shot: их пустые action лишь маркируют намерение, и
  // main.ts проваливается в интерактивный REPL. `web` долгоживущий (сервер
  // стартует из main.ts после parse). `mma init`/`mma setup` — one-shot визарды.
  const longRunningCommands = new Set(["meet", "agents", "web", "serve"]);
  for (const cmd of program.commands) {
    if (longRunningCommands.has(cmd.name())) continue;
    attachOneShotExit(cmd);
  }

  return program;
}
