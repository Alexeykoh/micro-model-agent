/**
 * `/security`, `/reload` и `/plugins` (list/show/enable/disable/reload).
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { readMmaVersion } from "../core/version";
import { activeProviderEndpoint } from "../modules/providers/manager";
import type { PluginManager } from "../modules/plugins/manager";
import { formatPluginDetails, formatPluginList } from "../modules/plugins/format";
import { reloadSummaryLines } from "../modules/plugins/reload";
import { mutateConfig } from "./config-mutations";
import { reportSaved } from "./repl-commands-shared";
import type { ReplContext } from "./repl-commands";

const version = readMmaVersion();

export function registerAgentCommands(ctx: ReplContext): void {
  const securityStatus = (): void => {
    const s = ctx.config.security;
    const flag = (v?: boolean) => (v ? t("reasoning.on") : t("reasoning.off"));
    const sep = pc.dim(" · ");
    ctx.output.writeLine(`security${sep}${flag(s?.enabled)}`);
    ctx.output.writeLine(
      `↳ bash ${flag(s?.bash.enabled)}${sep}paths ${flag(s?.paths.enabled)}${sep}network ${flag(s?.network.enabled)}`,
    );
    ctx.output.writeLine(
      `↳ contentScan ${flag(s?.contentScan.enabled)}${sep}encryption ${flag(s?.sessionEncryption.enabled)}`,
    );
  };

  const securityHandlers: Record<string, () => void> = {
    status: securityStatus,
  };

  ctx.registerCommand({
    name: "security",
    description: t("repl.security"),
    action: (args: string[]) => {
      const sub = args[0]?.trim().toLowerCase();
      const handler = sub ? securityHandlers[sub] : securityHandlers.status;
      if (!handler) {
        ctx.output.writeLine(pc.yellow(t("repl.unknown_sub", { cmd: "security", sub })));
        return;
      }
      handler();
    },
  });
  ctx.registerCommand({
    name: "reload",
    description: t("repl.reload"),
    usage: t("repl.reload_usage"),
    action: async () => {
      ctx.output.writeLine(pc.yellow(t("repl.reloading")));
      await ctx.reload();
      ctx.output.writeLine(pc.green(t("repl.reloaded")));
      ctx.output.writeLine(`${t("repl.model")}       ${ctx.config.model}`);
      ctx.output.writeLine(`${t("repl.context")}     ${ctx.config.contextWindow}`);
      const endpoint = activeProviderEndpoint(ctx.config.provider);
      ctx.output.writeLine(`${t("repl.provider")}    ${endpoint.type} @ ${endpoint.baseUrl}`);
    },
  });
  ctx.registerCommand({
    name: "plugins",
    description: t("repl.plugins"),
    usage: t("repl.plugins_usage"),
    action: (args: string[]) => runPluginsCommand(ctx, args, version),
  });
}

/** `/plugins [--all] | show <name> | enable <name> | disable <name>`. */
async function runPluginsCommand(
  ctx: ReplContext,
  args: string[],
  mmaVersion: string,
): Promise<void> {
  const manager = ctx.pluginManager;
  if (!manager) {
    ctx.output.writeLine(t("cli.plugins.none"));
    return;
  }
  const [sub, name] = args.filter((a) => a !== "--all");
  if (sub === "reload") return reloadPluginsCmd(ctx);
  if (sub === "show") return showPlugin(ctx, manager, name);
  if (sub === "enable" || sub === "disable") return togglePlugin(ctx, name, sub === "disable");
  listPlugins(ctx, manager, args.includes("--all"), mmaVersion);
}

/** `/plugins reload` — перечитать каталоги с диска, без пересборки агента. */
function reloadPluginsCmd(ctx: ReplContext): void {
  const manager = ctx.pluginManager;
  if (!manager) {
    ctx.output.writeLine(t("cli.plugins.none"));
    return;
  }
  const plugins = manager.reload();
  const skills = ctx.skillsModule?.reloadSources() ?? { added: 0, removed: 0 };
  for (const line of reloadSummaryLines(plugins, skills)) ctx.output.writeLine(line);
  listPlugins(ctx, manager, true, version);
}

/** `/plugins enable|disable <name>` — тот же единый путь записи, что и
 * `/config plugins.disabled`: setConfigValue применяет deny-list к живому
 * реестру через шов в registry.ts, здесь только считаем новый список. */
async function togglePlugin(
  ctx: ReplContext,
  name: string | undefined,
  off: boolean,
): Promise<void> {
  if (!name) {
    ctx.output.writeLine(t("cli.plugins.not_found", { name: "" }), "stderr");
    return;
  }
  const current = new Set(ctx.config.plugins?.disabled ?? []);
  if (off) current.add(name);
  else current.delete(name);
  const result = await mutateConfig(ctx, "plugins.disabled", [...current].join(","));
  if (!result.ok) {
    ctx.output.writeLine(
      pc.yellow(t("config.invalid_value", { key: "plugins.disabled" })),
      "stderr",
    );
    return;
  }
  reportSaved(ctx, result);
}

/** `/plugins show <name>` — те же подробности, что в поп-апе веб-вкладки. */
function showPlugin(ctx: ReplContext, manager: PluginManager, name: string | undefined): void {
  const record = manager.getRecords().find((r) => r.name === name);
  if (!record) {
    ctx.output.writeLine(t("cli.plugins.not_found", { name: name || "" }));
    return;
  }
  for (const line of formatPluginDetails(record, manager.getFailures(), manager.getToolConflicts())) {
    ctx.output.writeLine(line);
  }
}

/** `/plugins [--all]` — общий формат листинга (тот же, что у `mma plugins list`). */
function listPlugins(
  ctx: ReplContext,
  manager: PluginManager,
  showAll: boolean,
  mmaVersion: string,
): void {
  const records = manager.getRecords();
  const failures = manager.getFailures();
  const builtinCount = records.filter((r) => r.builtin).length;
  const lines = formatPluginList(records, failures, {
    showBuiltin: showAll,
    mmaVersion,
    hiddenHint: showAll ? 0 : builtinCount,
  });
  if (lines.length === 0) {
    ctx.output.writeLine(t("cli.plugins.none"));
    return;
  }
  for (const line of lines) ctx.output.writeLine(line);
  const unknown = (ctx.config.plugins?.disabled ?? []).filter((n) => !manager.isEnabled(n));
  if (unknown.length > 0) {
    ctx.output.writeLine(pc.dim(t("cli.plugins.unknown_names", { names: unknown.join(", ") })));
  }
}
