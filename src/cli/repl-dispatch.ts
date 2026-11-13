/**
 * Реестр и диспетчеризация slash-команд REPL: регистрация имени/алиасов,
 * разбор строки, справка и мост в общий каталог `core/commands`.
 *
 * Вынесено из `repl.ts` (правило 6). Карта хендлеров (правило #17) остаётся
 * единственным путём исполнения — здесь только её держатель.
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { errMsg } from "../utils";
import { CommandRegistry, groupCommands } from "../core/commands/catalog";
import { buildCommandCatalog } from "../core/commands/spec";
import type { OutputChannel } from "../output";
import type { SlashCommand } from "./repl-commands";
import type { HostCommandResult } from "../core/host";

/** Поля `Repl`, нужные диспетчеру команд. */
export interface ReplDispatchHost {
  commands: Map<string, SlashCommand>;
  output: OutputChannel;
  runHandledPrompt: boolean;
}

/** Регистрирует slash-команду (имя + алиасы). */
export function registerCommand(host: ReplDispatchHost, cmd: SlashCommand): void {
  host.commands.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      host.commands.set(alias, cmd);
    }
  }
}

/** Прогон slash-команды через ту же handler-map, что и ручной ввод. */
export async function executeCommand(host: ReplDispatchHost, line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return;
  await dispatchCommand(host, trimmed);
}

/** Host-путь: команда не роняет ход, ошибка становится результатом. */
export async function executeCommandResult(
  host: ReplDispatchHost,
  line: string,
): Promise<HostCommandResult> {
  try {
    await executeCommand(host, line);
    return { ok: true, output: [] };
  } catch (err) {
    return { ok: false, output: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function dispatchCommand(host: ReplDispatchHost, input: string): Promise<void> {
  const parts = input.split(/\s+/);
  const name = parts[0].slice(1);
  const args = parts.slice(1);

  // Сбрасываем протухший run-флаг прошлого прямого прогона, чтобы решение
  // presentPrompt() этой команды строилось на её собственном действии.
  host.runHandledPrompt = false;

  const cmd = host.commands.get(name);
  if (!cmd) {
    // Бывшие алиасы, уехавшие в субкоманду: указываем на новый синтаксис,
    // а не на голое "unknown command".
    const formerAliases: Record<string, string> = { use: "resume" };
    const suggestion = formerAliases[name];
    if (suggestion) {
      host.output.writeLine(
        pc.red(t("cli.unknown_command", { input: `/${name}`, suggestion: `/${suggestion}` })),
      );
    } else {
      host.output.writeLine(`${pc.red(t("cli.unknown_cmd", { name }))} ${t("cli.help_hint")}`);
    }
    return;
  }

  try {
    await cmd.action(args);
  } catch (err) {
    host.output.writeLine(
      pc.red(
        t("error.command_error", {
          message: errMsg(err),
        }),
      ),
      "stderr",
    );
  }
}

/** Показ помощи: общая или по команде (`/help <команда>`). */
export function showHelp(host: ReplDispatchHost, command?: string): void {
  // Справка строится по общему каталогу (`core/commands`), а не по таблице
  // групп: команда, не зарегистрированная в REPL, в справке не показывается,
  // а расхождение «каталог vs регистрация» ловит тест-сторож.
  const registry = commandRegistry(host);

  if (command) {
    const name = command.replace(/^\//, "");
    const cmd = registry.resolve(name);
    if (!cmd || !host.commands.get(name)) {
      host.output.writeLine(pc.red(t("repl.help_unknown", { name })));
      return;
    }
    host.output.writeLine(pc.bold(pc.cyan(`/${cmd.name}`)));
    host.output.writeLine(`  ${cmd.description}`);
    if (cmd.usage) host.output.writeLine(`  ${pc.dim(cmd.usage)}`);
    if (cmd.aliases?.length) {
      host.output.writeLine(pc.dim(`  ${t("repl.help_aliases", { names: cmd.aliases.join(", ") })}`));
    }
    if (cmd.examples?.length) {
      host.output.writeLine(pc.dim(`  ${t("repl.help_examples")}`));
      for (const ex of cmd.examples) host.output.writeLine(pc.dim(`    ${ex}`));
    }
    return;
  }

  // Только реально зарегистрированные команды: каталог описывает и то, что
  // терминал ещё не умеет (например, веб-only имя).
  const available = registry.list("terminal").filter((entry) => host.commands.has(entry.name));

  for (const { group, entries } of groupCommands(available, "terminal")) {
    host.output.writeLine(pc.bold(t(`repl.group.${group}`)));
    for (const cmd of entries) {
      const aliases = cmd.aliases?.length ? ` (${pc.dim(cmd.aliases.join(", "))})` : "";
      host.output.writeLine(`  ${pc.cyan(`/${cmd.name}`)}${aliases}  ${pc.dim(cmd.description)}`);
      if (cmd.usage) {
        host.output.writeLine(`    ${pc.dim(cmd.usage)}`);
      }
    }
    host.output.writeLine("");
  }
}

/**
 * Реестр команд REPL: каталог (`core/commands/spec`) + фактический состав
 * `this.commands`. Пересобирается на каждый вызов, чтобы после смены локали
 * (`reregisterCommands`) подписи в справке были свежими.
 */
export function commandRegistry(host: ReplDispatchHost): CommandRegistry {
  const registry = new CommandRegistry(buildCommandCatalog());
  for (const [key, cmd] of host.commands) {
    registry.bind(key, (args) => cmd.action(args));
  }
  return registry;
}
