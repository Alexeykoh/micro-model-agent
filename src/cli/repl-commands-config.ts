/**
 * Команды настроек и агента: `/config`, `/reasoning`, `/verbose`, `/status`,
 * `/wizard`, `/sysprompt`, `/map`.
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { resolveVerbosity } from "../ui/theme";
import { t } from "../i18n/index";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { saveConfig } from "../config/config";
import { getConfigValue, keysForGroup } from "../config/registry";
import { join, dirname } from "path";
import { mutateConfig, renderConfigError } from "./config-mutations";
import { runConfigReset } from "./config-reset";
import { runConfigMigrate } from "./repl-commands-migrate";
import type { IndexerModule } from "../modules/indexer/module";
import { runMapAction } from "../modules/indexer/map-command";
import { printReasoningStatus, reportSaved, showConfigTable } from "./repl-commands-shared";
import type { ReplContext } from "./repl-commands";

export function registerConfigCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "config",
    description: t("repl.config"),
    usage: t("repl.config_usage"),
    examples: ["/config", "/config model", "/config reasoning.mode high", "/config reset ui.verbosity"],
    action: async (args: string[]) => {
      // Роутинг субкоманды `/config migrate`. Отдельная регистрация с пробелом в
      // имени недостижима: диспетчер режет ввод по пробелам, и "/config migrate"
      // всегда резолвился в plain "config".
      if ((args[0] ?? "").trim().toLowerCase() === "migrate") {
        return runConfigMigrate(ctx);
      }
      if (args.length === 0) {
        showConfigTable(ctx);
        return;
      }
      if (args[0] === "page") {
        // Переход на страницу списка настроек: `/config page 2`.
        const page = Number(args[1]);
        if (!Number.isFinite(page) || page < 1) {
          ctx.output.writeLine(pc.red(t("config.page_bad")));
          return;
        }
        showConfigTable(ctx, undefined, Math.floor(page));
        return;
      }
      if (args[0] === "reset") {
        await runConfigReset(ctx, args.slice(1));
        return;
      }
      const name = args[0];
      if (args.length === 1) {
        const group = keysForGroup(name);
        if (group.length > 0) {
          showConfigTable(ctx, group);
          return;
        }
        const got = getConfigValue(ctx.config, name);
        if (!got.ok) {
          renderConfigError(ctx, got);
          return;
        }
        ctx.output.writeLine(`${got.key} = ${got.display}`);
        return;
      }
      const raw = args.slice(1).join(" ");
      const result = await mutateConfig(ctx, name, raw);
      if (!result.ok) {
        renderConfigError(ctx, result);
        return;
      }
      reportSaved(ctx, result);
      if (result.key === "model") {
        const known = ctx.knownModels();
        if (known.length > 0 && !known.includes(String(result.value))) {
          ctx.output.writeLine(pc.yellow(t("model.not_in_list", { name: String(result.value) })));
        }
      }
    },
  });
  ctx.registerCommand({
    name: "reasoning",
    description: t("repl.reasoning"),
    usage: t("repl.reasoning_usage"),
    examples: ["/reasoning", "/reasoning show", "/reasoning level high"],
    action: async (args: string[]) => {
      const sub = args[0]?.trim().toLowerCase();
      if (!sub) {
        printReasoningStatus(ctx);
        return;
      }
      if (sub === "show" || sub === "on" || sub === "hide" || sub === "off") {
        const on = sub === "show" || sub === "on";
        const result = await mutateConfig(ctx, "showReasoning", on ? "on" : "off");
        if (!result.ok) {
          renderConfigError(ctx, result);
          return;
        }
        ctx.output.writeLine(
          pc.green(
            t("reasoning.display_set", { state: on ? t("reasoning.on") : t("reasoning.off") }),
          ),
        );
        return;
      }
      if (sub === "level") {
        const lvl = args[1]?.trim().toLowerCase();
        if (!lvl) {
          ctx.output.writeLine(t("repl.reasoning_usage"));
          return;
        }
        const result = await mutateConfig(ctx, "reasoning.mode", lvl);
        if (!result.ok) {
          renderConfigError(ctx, result);
          return;
        }
        ctx.output.writeLine(pc.green(t("repl.reasoning_level_set", { level: lvl })));
        if (lvl !== "auto") ctx.output.writeLine(pc.dim(t("reasoning.auto_off_hint")));
        return;
      }
      ctx.output.writeLine(pc.yellow(t("reasoning.unknown_sub", { sub })));
      ctx.output.writeLine(t("repl.reasoning_usage"));
    },
  });
  ctx.registerCommand({
    name: "verbose",
    description: t("repl.verbose"),
    usage: t("repl.verbose_usage"),
    examples: ["/verbose", "/verbose normal"],
    action: async (args: string[]) => {
      const level = args[0]?.trim().toLowerCase();
      if (!level) {
        ctx.output.writeLine(t("verbose.status", { level: resolveVerbosity(ctx.config.ui) }));
        return;
      }
      const result = await mutateConfig(ctx, "ui.verbosity", level);
      if (!result.ok) {
        renderConfigError(ctx, result);
        return;
      }
      ctx.output.writeLine(pc.green(t("repl.verbose_set", { level: result.display })));
    },
  });
  ctx.registerCommand({
    name: "status",
    description: t("repl.status"),
    usage: t("repl.status_usage"),
    action: () => {
      const providers = ctx.agent.listProviders();
      const active = providers.find((p) => p.active);
      const providerLabel = active ? active.label : ctx.config.provider.type;
      const parts = [ctx.config.model, providerLabel];
      const meta = ctx.sessionManager?.getActiveMeta();
      if (meta) parts.push(`${meta.name} (${meta.messageCount} ${t("repl.msgs")})`);
      parts.push(`${ctx.config.contextWindow} tok`);
      ctx.output.writeLine(parts.join(pc.dim(" · ")));
    },
  });
  ctx.registerCommand({
    name: "wizard",
    description: t("repl.wizard"),
    aliases: ["setup"],
    usage: t("repl.wizard_usage"),
    action: async () => {
      ctx.output.writeLine(pc.yellow(t("repl.wizard_running")));
      // Визард владеет терминалом целиком (`withInput`): его меню печатаются
      // напрямую, а не поверх живой строки ввода — терминальная деталь,
      // спрятанная за фронтендовым контрактом ввода.
      const answers = await ctx.input.withInput((prompt) => runSetup(prompt));
      const configPath = join(ctx.configDir, "config.json");
      applyAnswersToConfig(ctx.config, answers);
      saveConfig(ctx.config, configPath, dirname(configPath));
      await ctx.agent.reconfigure(ctx.config);
      ctx.output.writeLine(pc.green(t("cli.config_saved")));
    },
  });
  ctx.registerCommand({
    name: "sysprompt",
    description: t("repl.sysprompt_desc"),
    usage: t("repl.sysprompt_usage"),
    examples: ["/sysprompt", "/sysprompt --full"],
    action: (args: string[]) => {
      const info = ctx.agent.getSystemPromptInfo();
      const full = args.includes("--full");
      ctx.output.writeLine(pc.bold(t("repl.sysprompt_tokens", { count: String(info.tokenCount) })));
      if (info.excluded.length > 0) {
        ctx.output.writeLine(
          pc.yellow(t("repl.excluded_blocks", { count: String(info.excluded.length) })),
        );
        for (const e of info.excluded) {
          ctx.output.writeLine(pc.dim(`  - ${e.slice(0, 80)}${e.length > 80 ? "..." : ""}`));
        }
      }
      if (full) {
        ctx.output.writeLine(pc.dim("─".repeat(60)));
        for (const line of info.text.split("\n")) {
          ctx.output.writeLine(line);
        }
        ctx.output.writeLine(pc.dim("─".repeat(60)));
      } else {
        ctx.output.writeLine(pc.dim(t("repl.sysprompt_full_hint")));
      }
    },
  });
  ctx.registerCommand({
    name: "map",
    description: t("repl.map"),
    usage: t("repl.map_usage"),
    action: async (args: string[]) => {
      const indexer = ctx.agent.getModule<IndexerModule>("indexer");
      if (!indexer) {
        ctx.output.writeLine(pc.yellow(t("indexer.not_indexed")));
        return;
      }
      const action = args[0] || "summary";
      const query = args.slice(1).join(" ");
      const result = await runMapAction(indexer, action, query);
      ctx.output.writeLine(result.output);
    },
  });
}
