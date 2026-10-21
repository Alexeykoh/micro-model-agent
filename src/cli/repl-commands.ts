// Slash-команды REPL: /config, /model, /provider, сессии, сахар над mutateConfig.
import { pc } from "../ui/colors";
import { resolveVerbosity } from "../ui/theme";
import { readMmaVersion } from "../core/version";
import { renderTable } from "../ui/table";
import { t, } from "../i18n/index";
import { runSetup } from "./setup";
import { applyAnswersToConfig } from "./setup-order";
import { saveConfig } from "../config/config";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { providerNameTaken } from "../modules/providers/naming";
import { activeProviderEndpoint } from "../modules/providers/manager";
import { budgetBreakdownLines } from "../config/budget";
import {
  getConfigValue,
  keysForGroup,
  configDefs,
  formatConfigValue,
  type ConfigKeyDef,
  type ConfigSetResult,
} from "../config/registry";
import {
  formatExport,
  redactExport,
  sanitizeFileName,
  extensionFor,
  type ExportFormat,
} from "../modules/session/export";
import { getMessageText } from "../llm/provider";
import { join, dirname } from "path";
import {
  mutateConfig,
  persistConfig,
  renderConfigError,
} from "./config-mutations";
import { runConfigReset } from "./config-reset";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import type { PluginManager } from "../modules/plugins/manager";
import type { CommandContext } from "./command-context";
import { formatPluginDetails, formatPluginList } from "../modules/plugins/format";
import { reloadSummaryLines } from "../modules/plugins/reload";
import type { IndexerModule } from "../modules/indexer/module";
import { runMapAction } from "../modules/indexer/map-command";
import { registerOnboardingCommands } from "./onboarding-commands";
import { errMsg } from "../utils";
import { globalExportsDir } from "../config/paths";
import { registerLspCommands } from "./repl-commands-lsp";
import { registerSkillCommands } from "./repl-commands-skills";
import { registerDoctorCommands } from "./repl-commands-doctor";

const version = readMmaVersion();

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
 * Исторически здесь был интерфейс на 20 членов, смешивавший сервисы
 * (config/agent/модули) и терминальный ввод-вывод (`rl: LineInput`,
 * `output: OutputChannel`). Разделено в `command-context.ts`:
 * {@link CommandServices} (фронтендонезависимо), {@link CommandOutput}
 * (3 метода вместо всего канала) и {@link CommandInput} — чтобы TUI
 * подключил тот же реестр, реализовав две маленькие поверхности.
 */
export type ReplContext = CommandContext;

/**
 * Группы команд для `/help` больше не хранятся здесь: раньше была отдельная
 * карта на 29 строк, синхронизировавшаяся вручную с регистрациями. Теперь
 * группа объявляется рядом с описанием команды в общем каталоге
 * (`src/core/commands/spec.ts`), а `/help` группирует через `groupCommands`.
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

function registerRunCommands(ctx: ReplContext): void {
  ctx.registerCommand({
    name: "run",
    description: t("repl.run"),
    usage: t("repl.run_usage"),
    action: async (args: string[]) => {
      if (args.length === 0) {
        ctx.output.writeLine(t("repl.run_usage"));
        return;
      }
      const prompt = args.join(" ");
      await ctx.runAgent(prompt);
    },
  });
  ctx.registerCommand({
    name: "image",
    description: t("repl.image"),
    aliases: ["img"],
    usage: t("repl.image_usage"),
    action: async (args: string[]) => {
      const source = args.join(" ");
      if (!source) {
        ctx.output.writeLine(t("repl.image_usage"));
        return;
      }
      try {
        const { loadFileAsDataUrl, loadUrlAsDataUrl, readClipboardImage } =
          await import("../llm/image-utils");
        const { existsSync } = await import("fs");
        const { resolve } = await import("path");

        let dataUrl: string;
        let label: string;

        if (source.toLowerCase() === "clipboard") {
          const clipBuf = await readClipboardImage();
          if (!clipBuf) {
            ctx.output.writeLine(pc.yellow(t("image.clipboard_empty")));
            return;
          }
          const { bufferToDataUrl } = await import("../llm/image-utils");
          const result = await bufferToDataUrl(clipBuf);
          dataUrl = result.dataUrl;
          label = "clipboard";
        } else if (source.startsWith("http://") || source.startsWith("https://")) {
          const result = await loadUrlAsDataUrl(source);
          dataUrl = result.dataUrl;
          label = source;
        } else {
          const absPath = resolve(process.cwd(), source);
          if (!existsSync(absPath)) {
            ctx.output.writeLine(pc.red(t("image.not_found", { path: source })), "stderr");
            return;
          }
          const result = await loadFileAsDataUrl(absPath);
          dataUrl = result.dataUrl;
          label = source;
        }

        const contextManager = ctx.agent.contextManager;
        if (!contextManager) {
          ctx.output.writeLine(pc.red(t("image.no_context")), "stderr");
          return;
        }

        contextManager.addPendingImage({
          type: "image_url",
          image_url: { url: dataUrl },
        });

        const sizeKb = Math.round((dataUrl.length * 3) / 4 / 1024);
        ctx.output.writeLine(
          pc.green(t("image.attached", { source: label, size: `${sizeKb} KB` })),
        );
      } catch (err: any) {
        ctx.output.writeLine(pc.red(t("image.error", { message: err.message })), "stderr");
      }
    },
  });
}

const SUGAR_HINTS: Record<string, string> = {
  model: "/model use <name>",
  "provider.active": "/provider use <name>",
  contextWindow: "/context <size>",
  "contextBudget.systemPrompt": "/context system <share>",
  "contextBudget.responseReserve": "/context reserve <share>",
  showReasoning: "/reasoning show | hide",
  "reasoning.mode": "/reasoning level <level>",
  "ui.verbosity": "/verbose <level>",
};

function changeHint(def: ConfigKeyDef): string {
  if (def.readOnly) return t("config.read_only_hint");
  return SUGAR_HINTS[def.key] ?? `/config ${def.key} <value>`;
}

/** Отчёт об успешной записи настройки. */
function reportSaved(ctx: ReplContext, result: ConfigSetResult & { ok: true }): void {
  ctx.output.writeLine(pc.green(t("config.saved", { key: result.key })));
}

/** Таблица настроек (текущее значение + подсказка по смене). */
function printConfigTable(ctx: ReplContext, defs?: ConfigKeyDef[]): void {
  const list = defs ?? configDefs();
  const rows = list.map((def) => [
    def.key,
    formatConfigValue(def.get(ctx.config)),
    def.domain,
    changeHint(def),
  ]);
  ctx.output.writeLine(pc.bold(t("config.header")));
  for (const line of renderTable(
    [
      t("config.col_setting"),
      t("config.col_value"),
      t("config.col_domain"),
      t("config.col_change"),
    ],
    rows,
  )) {
    ctx.output.writeLine(line);
  }
  const meta = ctx.sessionManager?.getActiveMeta();
  if (meta) {
    ctx.output.writeLine(
      pc.dim(
        t("config.session_line", {
          name: meta.name,
          id: meta.id,
          count: String(meta.messageCount),
        }),
      ),
    );
  }
  ctx.output.writeLine(pc.dim(t("config.usage_hint")));
}

function printReasoningStatus(ctx: ReplContext): void {
  const display = ctx.config.showReasoning ? t("reasoning.on") : t("reasoning.off");
  const mode = ctx.config.reasoning?.mode ?? "auto";
  const auto = mode === "auto" ? t("reasoning.auto_on") : t("reasoning.auto_off");
  ctx.output.writeLine(t("reasoning.status", { display, level: mode, auto }));
}

function registerConfigCommands(ctx: ReplContext): void {
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
        printConfigTable(ctx);
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
          printConfigTable(ctx, group);
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
        ctx.output.writeLine(
          t("verbose.status", { level: resolveVerbosity(ctx.config.ui) }),
        );
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

function registerProviderCommands(ctx: ReplContext): void {
  const list = (): void => {
    const providers = ctx.agent.listProviders();
    if (providers.length === 0) {
      const endpoint = activeProviderEndpoint(ctx.config.provider);
      ctx.output.writeLine(`${t("repl.provider_current")}  ${endpoint.type}`);
      ctx.output.writeLine(`  ${endpoint.baseUrl}`);
      return;
    }
    ctx.output.writeLine(t("repl.provider_current"));
    for (const p of providers) {
      const marker = p.active ? pc.green("* ") : "  ";
      ctx.output.writeLine(` ${marker}${p.label}  (${pc.dim(p.type)})  ${pc.dim(p.baseUrl)}`);
    }
  };

  const use = async (args: string[]): Promise<void> => {
    const name = args[0];
    if (!name) {
      ctx.output.writeLine(t("repl.provider_usage"));
      return;
    }
    const result = await mutateConfig(ctx, "provider.active", name);
    if (!result.ok) {
      renderConfigError(ctx, result);
      return;
    }
    ctx.refreshModelCache();
    ctx.output.writeLine(pc.green(t("repl.provider_set", { name })));
    reportSaved(ctx, result);
  };

  const add = async (args: string[]): Promise<void> => {
    const flags: Record<string, string> = {};
    let name: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith("--")) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          ctx.output.writeLine(
            pc.red(t("repl.provider_add_missing_value", { flag: arg })),
            "stderr",
          );
          return;
        }
        flags[arg.slice(2)] = value;
        i++;
      } else if (name === undefined) {
        name = arg;
      }
    }
    if (!name) {
      ctx.output.writeLine(t("repl.provider_usage"));
      return;
    }
    for (const flag of ["priority", "context-window", "rpm", "parallel"]) {
      const v = flags[flag];
      if (v !== undefined && !Number.isFinite(Number(v))) {
        ctx.output.writeLine(
          pc.red(t("repl.provider_add_invalid_number", { flag: `--${flag}`, value: v })),
          "stderr",
        );
        return;
      }
    }
    const entries = Array.isArray(ctx.config.provider.entries) ? ctx.config.provider.entries : [];
    if (entries.length === 0) {
      entries.push({
        type: ctx.config.provider.type,
        label: ctx.config.provider.type,
        baseUrl: ctx.config.provider.baseUrl,
        apiKey: ctx.config.provider.apiKey,
      });
    }
    const baseUrl =
      flags.url || HOSTED_BASE_URLS[name] || HOSTED_BASE_URLS[`opencode-${name}`] || "";
    if (!baseUrl) {
      ctx.output.writeLine(pc.red(t("cli.provider_no_url", { name })), "stderr");
      return;
    }
    if (providerNameTaken(entries, name)) {
      ctx.output.writeLine(pc.red(t("cli.provider_name_conflict", { name })), "stderr");
      return;
    }
    entries.push({
      type: name,
      label: name,
      baseUrl,
      apiKey: flags.key,
      ...(flags.priority !== undefined ? { priority: Number(flags.priority) } : {}),
      ...(flags["context-window"] !== undefined
        ? { contextWindow: Number(flags["context-window"]) }
        : {}),
      ...(flags.rpm !== undefined || flags.parallel !== undefined
        ? {
            rateLimits: {
              maxRequestsPerMinute: Number(flags.rpm ?? 0) || 60,
              maxParallelTasks: Number(flags.parallel ?? 0) || 1,
            },
          }
        : {}),
    });
    ctx.config.provider.entries = entries;
    ctx.config.provider.active = ctx.config.provider.active || ctx.config.provider.type;
    persistConfig(ctx);
    await ctx.agent.reconfigure(ctx.config);
    ctx.output.writeLine(pc.green(t("cli.provider_added", { name })));
    ctx.output.writeLine(t("repl.provider_switch_hint", { name }));
  };

  const handlers: Record<string, (args: string[]) => void | Promise<void>> = {
    list,
    use,
    add,
  };

  ctx.registerCommand({
    name: "provider",
    description: t("repl.provider_list"),
    usage: t("repl.provider_usage"),
    examples: ["/provider list", "/provider use openrouter", "/provider add openai --key sk-..."],
    action: async (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? handlers[subcmd] : handlers.list;
      if (!handler) {
        ctx.output.writeLine(pc.yellow(t("repl.unknown_sub", { cmd: "provider", sub: subcmd })));
        ctx.output.writeLine(t("repl.provider_usage"));
        return;
      }
      await handler(args.slice(1));
    },
  });
  const listModels = async (): Promise<void> => {
    ctx.output.writeLine(`${t("repl.model_current")}  ${ctx.config.model}`);

    const { OpenAICompatProvider } = await import("../llm/openai-compat");
    const provider = new OpenAICompatProvider({
      model: ctx.config.model,
      baseUrl: ctx.config.provider.baseUrl,
      apiKey: ctx.config.provider.apiKey,
      contextWindow: ctx.config.contextWindow,
    });

    const { Spinner } = await import("../ui/spinner");
    // Оверлей опционален у фронтенда; без него спиннер пишет в stderr сам
    // (см. `Spinner.tick`), поэтому узкий канал тут просто не передаём.
    const overlay = ctx.output.writeOverlay;
    const s = new Spinner(
      overlay ? { channel: { writeOverlay: (text: string) => overlay.call(ctx.output, text) } } : {},
    );
    s.start(t("cli.fetching_models"));
    try {
      const models = await provider.listModels();
      s.stop();
      if (models.length > 0) {
        ctx.refreshModelCache();
        ctx.output.writeLine(t("cli.available_models"));
        const { getCertMark } = await import("../modules/certification/manifest");
        for (const m of models) {
          const marker = m === ctx.config.model ? pc.green("* ") : "  ";
          const mark = getCertMark(m, ctx.config.provider.baseUrl, version, process.cwd());
          const cert =
            mark === "certified" ? pc.green("✔") : mark === "stale" ? pc.yellow("○") : pc.dim("·");
          const label =
            mark === "certified"
              ? `  ${pc.green(t("cli.cert_label"))}`
              : mark === "stale"
                ? `  ${pc.yellow(t("cli.cert_stale_label"))}`
                : "";
          ctx.output.writeLine(` ${marker}${cert} ${m}${label}`);
        }
      } else {
        ctx.output.writeLine(t("cli.no_models_found"));
      }
    } catch (err) {
      s.stop();
      ctx.output.writeLine(t("cli.model_fetch_failed", { error: String(err) }), "stderr");
    }

    ctx.output.writeLine(t("cli.model_hint"));
  };

  const useModel = async (args: string[]): Promise<void> => {
    const name = args[0];
    if (!name) {
      ctx.output.writeLine(t("repl.model_usage"));
      return;
    }
    const result = await mutateConfig(ctx, "model", name);
    if (!result.ok) {
      renderConfigError(ctx, result);
      return;
    }
    ctx.output.writeLine(pc.green(t("repl.model_set", { name })));
    const known = ctx.knownModels();
    if (known.length > 0 && !known.includes(name)) {
      ctx.output.writeLine(pc.yellow(t("model.not_in_list", { name })));
    }
    reportSaved(ctx, result);
  };

  const modelHandlers: Record<string, (args: string[]) => void | Promise<void>> = {
    list: listModels,
    use: useModel,
  };

  ctx.registerCommand({
    name: "model",
    description: t("repl.model_list"),
    usage: t("repl.model_usage"),
    examples: ["/model list", "/model use qwen/qwen3.5-9b"],
    action: async (args: string[]) => {
      const subcmd = args[0];
      const handler = subcmd ? modelHandlers[subcmd] : modelHandlers.list;
      if (!handler) {
        ctx.output.writeLine(pc.yellow(t("repl.unknown_sub", { cmd: "model", sub: subcmd })));
        ctx.output.writeLine(t("repl.model_usage"));
        return;
      }
      await handler(args.slice(1));
    },
  });
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

function registerAgentCommands(ctx: ReplContext): void {
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
      ctx.output.writeLine(
        `${t("repl.provider")}    ${endpoint.type} @ ${endpoint.baseUrl}`,
      );
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
async function runPluginsCommand(ctx: ReplContext, args: string[], mmaVersion: string): Promise<void> {
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
async function togglePlugin(ctx: ReplContext, name: string | undefined, off: boolean): Promise<void> {
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
function listPlugins(ctx: ReplContext, manager: PluginManager, showAll: boolean, mmaVersion: string): void {
  const records = manager.getRecords();
  const failures = manager.getFailures();
  const builtinCount = records.filter((r) => r.builtin).length;
  const visible = showAll ? records : records.filter((r) => !r.builtin);
  if (visible.length === 0 && failures.length === 0) {
    ctx.output.writeLine(t("cli.plugins.none"));
    return;
  }
  const lines = formatPluginList(records, failures, {
    showBuiltin: showAll,
    mmaVersion,
    hiddenHint: showAll ? 0 : builtinCount,
  });
  for (const line of lines) ctx.output.writeLine(line);
  const unknown = (ctx.config.plugins?.disabled ?? []).filter((n) => !manager.isEnabled(n));
  if (unknown.length > 0) {
    ctx.output.writeLine(pc.dim(t("cli.plugins.unknown_names", { names: unknown.join(", ") })));
  }
}

function registerMmaCommands(ctx: ReplContext): void {
  registerRunCommands(ctx);
  registerConfigCommands(ctx);
  registerProviderCommands(ctx);
  registerAgentCommands(ctx);
  registerLspCommands(ctx);
}

function registerSessionCommands(ctx: ReplContext): void {
  if (!ctx.sessionManager) return;

  ctx.registerCommand({
    name: "sessions",
    description: t("repl.sessions"),
    aliases: ["ls"],
    usage: t("repl.sessions_usage"),
    action: (args: string[]) => {
      if (args[0] === "prune") {
        const dry = args.includes("--dry-run");
        const active = ctx.sessionManager!.getActive();
        const candidates = ctx.sessionManager!.list().filter(
          (s) => s.id !== active && ctx.sessionManager!.isEmptySession(s.id),
        );
        if (candidates.length === 0) {
          ctx.output.writeLine(t("session.prune_empty"));
          return;
        }
        if (!dry) ctx.sessionManager!.pruneEmpty(active ?? undefined);
        ctx.output.writeLine(t(dry ? "session.prune_dry" : "session.pruned", { n: candidates.length }));
        for (const s of candidates) {
          ctx.output.writeLine(pc.dim(`   ${s.id.slice(0, 12)}  ${s.name}`));
        }
        return;
      }
      const sessions = ctx.sessionManager!.list();
      const active = ctx.sessionManager!.getActive();
      if (sessions.length === 0) {
        ctx.output.writeLine(t("session.no_sessions_hint"));
        return;
      }
      const rows = sessions.map((s) => [
        s.id === active ? pc.green("●") : "",
        s.id.slice(0, 12),
        s.name,
        s.updatedAt.slice(0, 19).replace("T", " "),
        String(s.messageCount),
      ]);
      for (const line of renderTable(
        [
          t("session.col_active"),
          t("session.col_id"),
          t("session.col_name"),
          t("session.col_updated"),
          t("session.col_msgs"),
        ],
        rows,
      )) {
        ctx.output.writeLine(line);
      }
      ctx.output.writeLine(pc.dim(`\n  ${t("repl.resume_hint")}`));
    },
  });

  ctx.registerCommand({
    name: "new",
    description: t("repl.new"),
    aliases: ["create"],
    usage: t("repl.new_usage"),
    action: (args: string[]) => {
      const name = args.join(" ") || undefined;
      const meta = ctx.sessionManager!.create(name);
      ctx.agent.clearContext();
      // План следует за сессией: новая — без плана, трекер сбрасывается.
      const exec = ctx.agent.getModule<{
        switchSession(id: string | null): void;
        getPlanSummary(): string | null;
      }>("execution");
      try {
        exec?.switchSession(meta.id);
      } catch {
        // fail-open: сессия создана, план остался как был
      }
      ctx.output.clearScreen();
      ctx.output.writeLine(
        `${t("session.created", { name: meta.name })} (${pc.dim(meta.id.slice(0, 12))})`,
      );
      ctx.output.writeLine(pc.dim(`  ${t("session.chat_cleared")}\n`));
    },
  });

  ctx.registerCommand({
    name: "resume",
    description: t("repl.resume"),
    aliases: ["switch"],
    usage: t("repl.resume_usage"),
    examples: ["/resume", "/resume my-session"],
    action: (args: string[]) => {
      const query = args.join(" ");
      const sessions = ctx.sessionManager!.list();
      if (!query) {
        ctx.output.writeLine(pc.dim(t("session.available")));
        const active = ctx.sessionManager!.getActive();
        for (const s of sessions) {
          const marker = s.id === active ? pc.green(" *") : "  ";
          ctx.output.writeLine(pc.dim(` ${marker} ${s.id.slice(0, 12)}  ${s.name}`));
        }
        ctx.output.writeLine(pc.dim(`\n  ${t("repl.resume_usage")}`));
        return;
      }
      const match = sessions.find(
        (s) =>
          s.id === query ||
          s.id.startsWith(query) ||
          s.name.toLowerCase().includes(query.toLowerCase()),
      );
      if (!match) {
        ctx.output.writeLine(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.setActive(match.id);
      const history = ctx.sessionManager!.loadHistory();
      ctx.agent.setContext(history);
      // План следует за сессией: трекер переключается на план этой сессии
      // (или пустеет, если у неё плана нет).
      const exec = ctx.agent.getModule<{
        switchSession(id: string | null): void;
        getPlanSummary(): string | null;
      }>("execution");
      let planLine: string | null = null;
      try {
        exec?.switchSession(match.id);
        planLine = exec?.getPlanSummary() ?? null;
      } catch {
        // fail-open: история загружена, план остался как был
      }
      ctx.output.clearScreen();
      ctx.output.writeLine(
        pc.bold(pc.green(t("session.resumed", { name: match.name }))) +
          " " +
          pc.dim(`(${match.id.slice(0, 12)})`) +
          "  —  " +
          match.messageCount +
          " " +
          t("repl.msgs"),
      );
      ctx.output.writeLine(pc.dim("─".repeat(50)));
      if (history.length === 0) {
        ctx.output.writeLine(pc.dim(t("session.no_history")));
      } else {
        ctx.output.writeLine(pc.dim(t("session.chat_history")));
        ctx.output.writeLine("");
        for (const msg of history) {
          if (msg.role === "user") {
            ctx.output.writeLine(pc.cyan(`${t("session.user_label")}:`));
            ctx.output.writeLine(getMessageText(msg.content));
            ctx.output.writeLine("");
          } else if (msg.role === "assistant") {
            ctx.output.writeLine(pc.green(`${t("session.assistant_label")}:`));
            ctx.output.writeLine(getMessageText(msg.content));
            ctx.output.writeLine("");
          }
        }
      }
      ctx.output.writeLine(pc.dim("─".repeat(50)));
      ctx.output.writeLine(pc.dim(`  ${t("session.chat_loaded")}`));
      ctx.output.writeLine(pc.dim(`  ◇ ${planLine ?? t("plan.no_active")}`));
    },
  });

  ctx.registerCommand({
    name: "rename",
    description: t("repl.rename"),
    usage: t("repl.rename_usage"),
    action: (args: string[]) => {
      const name = args.join(" ");
      if (!name) {
        ctx.output.writeLine(t("repl.rename_usage"));
        return;
      }
      const active = ctx.sessionManager!.getActive();
      if (!active) {
        ctx.output.writeLine(t("session.no_active"));
        return;
      }
      ctx.sessionManager!.rename(active, name);
      ctx.output.writeLine(t("session.renamed", { name }));
    },
  });

  ctx.registerCommand({
    name: "delete",
    description: t("repl.delete"),
    aliases: ["rm"],
    usage: t("repl.delete_usage"),
    action: (args: string[]) => {
      const query = args[0];
      if (!query) {
        ctx.output.writeLine(t("repl.delete_usage"));
        return;
      }
      const sessions = ctx.sessionManager!.list();
      const match = sessions.find((s) => s.id === query || s.id.startsWith(query));
      if (!match) {
        ctx.output.writeLine(t("session.no_match", { query }));
        return;
      }
      ctx.sessionManager!.delete(match.id);
      // План следует за сессией: слот удалённой сессии не оставляем мусором.
      try {
        ctx.agent
          .getModule<{ forgetSession(id: string): void }>("execution")
          ?.forgetSession(match.id);
      } catch {
        /* best-effort */
      }
      ctx.output.writeLine(`${t("session.deleted", { id: match.id })}: ${match.name}`);
    },
  });

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
async function runConfigMigrate(ctx: ReplContext): Promise<void> {
  const { hasDomainFiles } = await import("../config/domains");
  const { loadConfig: loadCfg } = await import("../config/config");
  const configDir = ctx.configDir;
  const configPath = join(configDir, "config.json");

  if (hasDomainFiles(configDir)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  if (!existsSync(configPath)) {
    ctx.output.writeLine(pc.yellow(t("config.migrate_no_legacy")));
    return;
  }

  ctx.output.writeLine(t("config.migrate_start"));

  const { config } = loadCfg({ configDir, projectConfigPath: join(configDir, ".mmrc") });
  saveConfig(config, configPath, configDir);

  const { renameSync, readdirSync } = await import("fs");
  renameSync(configPath, `${configPath}.bak`);

  const domainFiles = readdirSync(join(configDir, "config")).filter((f: string) =>
    f.endsWith(".json"),
  );
  ctx.output.writeLine(pc.green(t("config.migrate_done", { count: String(domainFiles.length) })));
}
