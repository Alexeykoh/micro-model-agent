/**
 * `/provider` (list/use/add) и `/model` (list/use).
 *
 * Вынесено из `repl-commands.ts` (правило 6).
 */
import { pc } from "../ui/colors";
import { t } from "../i18n/index";
import { readMmaVersion } from "../core/version";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { providerNameTaken } from "../modules/providers/naming";
import { activeProviderEndpoint } from "../modules/providers/manager";
import { mutateConfig, persistConfig, renderConfigError } from "./config-mutations";
import { buildProviderEntry } from "./provider-entry";
import { reportSaved } from "./repl-commands-shared";
import type { ReplContext } from "./repl-commands";

const version = readMmaVersion();

export function registerProviderCommands(ctx: ReplContext): void {
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
    // Лимиты задаёт пользователь: молчаливые 60/мин означали бы потолок,
    // которого никто не просил (аудит §7.13).
    const built = buildProviderEntry({
      name,
      baseUrl,
      apiKey: flags.key,
      priority: flags.priority,
      contextWindow: flags["context-window"],
      rpm: flags.rpm,
      parallel: flags.parallel,
    });
    if (!built.ok) {
      ctx.output.writeLine(pc.red(t("cli.provider_bad_number")), "stderr");
      return;
    }
    entries.push(built.entry);
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

    // Истина — активная запись `entries[]`: плоские поля протухают после
    // `/provider use` и уводили список моделей к чужому эндпоинту (аудит §7.7).
    const endpoint = activeProviderEndpoint(ctx.config.provider);
    const activeName =
      ctx.config.provider.active ??
      ctx.config.provider.entries?.[0]?.label ??
      endpoint.type;
    const provider = ctx.agent.getProviderFor(activeName);
    if (!provider) {
      ctx.output.writeLine(
        t("cli.model_provider_unavailable", { name: activeName }),
        "stderr",
      );
      ctx.output.writeLine(t("cli.model_hint"));
      return;
    }

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
          const mark = getCertMark(m, endpoint.baseUrl, version, process.cwd());
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
}
