/**
 * Серверный реестр slash-команд (split W12).
 *
 * Один каталог (`core/commands/spec.ts`) и одна карта хендлеров: её исполняют
 * `mma serve`, thin-REPL и web-адаптер. Команды, которым нужен интерактивный
 * терминал (wizard/meet/run/image/…), отвечают явной ошибкой, а не тишиной.
 */
import { t } from "../../../i18n/index";
import { buildCommandCatalog } from "../../../core/commands/spec";
import type { HostCommandResult } from "../../../core/host";
import type { AgentServiceState } from "../state";
import {
  configCommand,
  contextCommand,
  helpCommand,
  modelCommand,
  providerCommand,
  reasoningCommand,
  securityCommand,
  statusCommand,
  TERMINAL_ONLY,
  verboseCommand,
} from "./commands-core";
import {
  deleteCommand,
  exportCommand,
  lspCommand,
  mapCommand,
  memoryCommand,
  newCommand,
  pluginsCommand,
  reloadCommand,
  renameCommand,
  resumeCommand,
  sessionsCommand,
  skillCommand,
  syspromptCommand,
} from "./commands-data";
import { fail, type CommandCtx, type CommandHandler } from "./commands-types";

/** Карта команд: ключ — каноническое имя (правило #17, без цепочки `if`). */
const HANDLERS: Record<string, CommandHandler> = {
  help: helpCommand,
  status: statusCommand,
  config: configCommand,
  model: modelCommand,
  provider: providerCommand,
  context: contextCommand,
  reasoning: reasoningCommand,
  verbose: verboseCommand,
  security: securityCommand,
  export: exportCommand,
  memory: memoryCommand,
  sessions: sessionsCommand,
  session: sessionsCommand,
  new: newCommand,
  resume: resumeCommand,
  rename: renameCommand,
  delete: deleteCommand,
  sysprompt: syspromptCommand,
  map: mapCommand,
  lsp: lspCommand,
  skill: skillCommand,
  plugins: pluginsCommand,
  reload: reloadCommand,
};

/** Алиас → каноническое имя (берётся из каталога + web-имя `/sessions`). */
function aliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const spec of buildCommandCatalog()) {
    map.set(spec.name, spec.name);
    for (const alias of spec.aliases ?? []) map.set(alias.toLowerCase(), spec.name);
    if (spec.webName) map.set(spec.webName, spec.name);
  }
  return map;
}

/** Публичный каталог для `/v1/host/commands` и `/help`. */
export interface HostCommandInfo {
  name: string;
  description: string;
  usage?: string;
  available: boolean;
  reason?: "terminal-only";
}

/** Все объявленные команды с признаком «исполнима на проводе». */
export function hostCommandCatalog(): HostCommandInfo[] {
  return buildCommandCatalog().map((spec) => {
    const available = !TERMINAL_ONLY.has(spec.name) && !!HANDLERS[spec.name];
    return {
      name: spec.name,
      description: spec.description,
      ...(spec.usage ? { usage: spec.usage } : {}),
      available,
      ...(available ? {} : { reason: "terminal-only" as const }),
    };
  });
}

/** Исполняет slash-команду на рантайме демона. */
export async function runHostCommand(
  s: AgentServiceState,
  sessionId: string,
  line: string,
): Promise<HostCommandResult> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return fail(t("daemon.command_requires_slash"));
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
  const name = (rawName ?? "").toLowerCase();
  if (!name) return fail(t("daemon.command_requires_slash"));
  const canonical = aliasMap().get(name) ?? name;
  if (TERMINAL_ONLY.has(canonical)) {
    return fail(t("daemon.command_terminal_only", { name: canonical }));
  }
  const handler = HANDLERS[canonical];
  if (!handler) return fail(t("daemon.command_unknown", { name }));
  const ctx: CommandCtx = { s, sessionId };
  try {
    return await handler(ctx, args);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
