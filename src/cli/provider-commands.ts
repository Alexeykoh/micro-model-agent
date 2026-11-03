// Команды провайдеров: check/list/use/add (мульти-записный конфиг).
import type { Command } from "commander";
import { bootstrap } from "../core/bootstrap";
import { saveConfig } from "../config/config";
import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { dirname } from "path";
import { getDefaultChannel } from "../output";
import { globalConfigFile } from "../config/paths";
import { HOSTED_BASE_URLS } from "../modules/providers/presets";
import { providerNameTaken } from "../modules/providers/naming";
import { probeProviders, targetsFromProviders } from "../modules/providers/health";
import { fail } from "./exit-code";
import { buildProviderEntry } from "./provider-entry";

export function buildProviderCommands(program: Command): void {
  const provider = program.command("provider").description(t("cli.manage_providers"));
  provider
    .command("check")
    .description(t("cli.provider_check"))
    .option("--timeout <ms>", t("cli.probe_timeout"))
    .action(async (opts: { timeout?: string }) => {
      const { config, agent } = await bootstrap();
      const providers = agent.listProviders();
      const targets = targetsFromProviders(
        providers.length > 0
          ? providers
              .map((p) => ({ name: p.label, provider: agent.getProviderFor(p.label) }))
              .filter((x): x is { name: string; provider: NonNullable<typeof x.provider> } =>
                Boolean(x.provider),
              )
          : [
              {
                name: config.provider.type,
                provider: agent.getProviderFor(config.provider.active || config.provider.type),
              },
            ].filter((x): x is { name: string; provider: NonNullable<typeof x.provider> } =>
              Boolean(x.provider),
            ),
      );
      const results = await probeProviders(targets, {
        timeoutMs: opts.timeout ? Number(opts.timeout) : 5000,
      });
      for (const r of results) {
        const mark = r.ok ? pc.green("✓") : pc.red("✗");
        const detail = r.ok ? pc.dim(`${r.ms}ms, ${r.models} models`) : pc.red(r.error ?? "failed");
        getDefaultChannel().writeLine(` ${mark} ${r.name.padEnd(16)} ${detail}`);
      }
    });
  provider
    .command("list")
    .description(t("cli.list_providers"))
    .action(async () => {
      const { config, agent } = await bootstrap();
      const providers = agent.listProviders();
      if (providers.length > 0) {
        getDefaultChannel().writeLine(t("cli.current_provider"));
        for (const p of providers) {
          const marker = p.active ? pc.green("* ") : "  ";
          const prio = p.priority !== undefined ? `  ${pc.dim(`prio=${p.priority}`)}` : "";
          getDefaultChannel().writeLine(
            ` ${marker}${p.label}  (${pc.dim(p.type)})  ${pc.dim(p.baseUrl)}${prio}`,
          );
        }
        return;
      }
      getDefaultChannel().writeLine(`${t("cli.current_provider")} ${config.provider.type}`);
      getDefaultChannel().writeLine(`${t("cli.base_url")} ${config.provider.baseUrl}`);
    });
  provider
    .command("use")
    .argument("<name>", t("cli.provider_name"))
    .description(t("cli.set_provider"))
    .action(async (name: string) => {
      const configPath = globalConfigFile();
      const { config, agent } = await bootstrap();
      if (config.provider.entries && config.provider.entries.length > 0) {
        try {
          await agent.setProvider(name);
          // Персист: `agent.setProvider` мутит только in-memory конфиг, так что свитч
          // молча терялся на выходе для мульти-записных конфигов.
          saveConfig(config, configPath, dirname(configPath));
          getDefaultChannel().writeLine(t("cli.provider_set", { name }));
        } catch (e: any) {
          fail(pc.red(e.message));
        }
        return;
      }
      config.provider.type = name;
      const baseUrl = HOSTED_BASE_URLS[name];
      if (baseUrl) {
        config.provider.baseUrl = baseUrl;
      }
      saveConfig(config, configPath, dirname(configPath));
      getDefaultChannel().writeLine(t("cli.provider_set", { name }));
      if (baseUrl) {
        getDefaultChannel().writeLine(t("cli.provider_base_hint", { baseUrl }));
      }
    });
  provider
    .command("add")
    .argument("<name>", t("cli.provider_type_label"))
    .option("--url <url>", t("cli.provider_base_url"))
    .option("--key <key>", t("cli.provider_api_key"))
    .option("--priority <n>", t("cli.provider_priority"))
    .option("--context-window <n>", t("cli.provider_context_window"))
    .option("--rpm <n>", t("cli.provider_rpm"))
    .option("--parallel <n>", t("cli.provider_parallel"))
    .description(t("cli.add_provider"))
    .action(
      async (
        name: string,
        opts: {
          url?: string;
          key?: string;
          priority?: string;
          contextWindow?: string;
          rpm?: string;
          parallel?: string;
        },
      ) => {
        const configPath = globalConfigFile();
        const { config } = await bootstrap();
        const entries = Array.isArray(config.provider.entries) ? config.provider.entries : [];
        // Есть legacy-одиночка — сидим список сначала с него.
        if (entries.length === 0) {
          entries.push({
            type: config.provider.type,
            label: config.provider.type,
            baseUrl: config.provider.baseUrl,
            apiKey: config.provider.apiKey,
          });
        }
        const baseUrl =
          opts.url || HOSTED_BASE_URLS[name] || HOSTED_BASE_URLS[`opencode-${name}`] || "";
        if (!baseUrl) {
          getDefaultChannel().writeLine(pc.red(t("cli.provider_no_url", { name })));
          return;
        }
        if (providerNameTaken(entries, name)) {
          getDefaultChannel().writeLine(pc.red(t("cli.provider_name_conflict", { name })));
          return;
        }
        // Лимиты задаёт пользователь: молчаливые 60/мин означали бы потолок,
        // которого никто не просил (аудит §7.13).
        const built = buildProviderEntry({
          name,
          baseUrl,
          apiKey: opts.key,
          priority: opts.priority,
          contextWindow: opts.contextWindow,
          rpm: opts.rpm,
          parallel: opts.parallel,
        });
        if (!built.ok) {
          fail(t("cli.provider_bad_number"));
          return;
        }
        entries.push(built.entry);
        config.provider.entries = entries;
        config.provider.active = config.provider.active || config.provider.type;
        saveConfig(config, configPath, dirname(configPath));
        getDefaultChannel().writeLine(pc.green(t("cli.provider_added", { name })));
        getDefaultChannel().writeLine(t("cli.provider_switch_hint"));
      },
    );
}
