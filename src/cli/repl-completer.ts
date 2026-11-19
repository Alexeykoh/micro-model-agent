/**
 * Сборка комплитера REPL и фоновый кеш id моделей.
 *
 * Вынесено из `repl.ts` (правило 6): дерево провайдеров Tab-дополнения —
 * отдельный шов, не жизненный цикл REPL.
 */
import {
  SlashCommandProvider,
  SessionNameProvider,
  SubcommandProvider,
  SkillNameProvider,
  ProviderArgProvider,
  ModelArgProvider,
  FilePathProvider,
  ConfigKeyProvider,
  ConfigValueProvider,
  FlagProvider,
  CommandArgProvider,
  buildSlashCompletions,
  type Completer,
} from "./completer";
import { t } from "../i18n/index";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { SessionManager } from "../modules/session/manager";
import type { SkillsModule } from "../modules/skills/module";
import type { SlashCommand } from "./repl-commands";

/** Поля `Repl`, нужные комплитеру. */
export interface ReplCompleterHost {
  completer: Completer;
  modelCache: string[];
  commands: Map<string, SlashCommand>;
  config: AppConfig;
  baseDir: string;
  agent: Agent;
  sessionManager?: SessionManager;
  skillsModule?: SkillsModule;
}

/** Строит комплитер с нуля. */
export function setupCompleter(host: ReplCompleterHost): void {
  // Пересборка с нуля: /reload зовёт снова после bootstrap, и перерегистрация
  // без reset дублировала бы каждого провайдера.
  host.completer.reset();
  // `this.commands` ключуется каноническими именами И алиасами; итерация даёт
  // каждый дополняемый токен с описанием его команды.
  const slashCommands = buildSlashCompletions(host.commands);
  host.completer.registerProvider(new SlashCommandProvider(slashCommands));
  if (host.sessionManager) {
    const sessions = host.sessionManager;
    host.completer.registerProvider(
      new SessionNameProvider(() => sessions.list().map((s) => s.name), [
        "/resume",
        "/delete",
        "/export",
      ]),
    );
  }
  if (host.skillsModule) {
    const skills = host.skillsModule;
    host.completer.registerProvider(
      new SubcommandProvider("skill", [
        { name: "list", description: t("skill.sub_list") },
        { name: "loaded", description: t("skill.sub_loaded") },
        { name: "load", description: t("skill.sub_load") },
        { name: "unload", description: t("skill.sub_unload") },
        { name: "search", description: t("skill.sub_search") },
      ]),
    );
    host.completer.registerProvider(new SkillNameProvider(skills));
  }
  // Комплит субкоманд + аргументов управления provider/model.
  host.completer.registerProvider(
    new SubcommandProvider("provider", [
      { name: "list", description: t("provider.sub_list") },
      { name: "use", description: t("provider.sub_use") },
      { name: "add", description: t("provider.sub_add") },
    ]),
  );
  host.completer.registerProvider(
    new SubcommandProvider("model", [
      { name: "list", description: t("model.sub_list") },
      { name: "use", description: t("model.sub_use") },
    ]),
  );
  host.completer.registerProvider(
    new SubcommandProvider("map", [
      { name: "summary", description: t("map.sub_summary") },
      { name: "refresh", description: t("map.sub_refresh") },
      { name: "find", description: t("map.sub_find") },
    ]),
  );
  host.completer.registerProvider(
    new SubcommandProvider("context", [
      { name: "system", description: t("context.sub_system") },
      { name: "reserve", description: t("context.sub_reserve") },
    ]),
  );
  host.completer.registerProvider(
    new SubcommandProvider("lsp", [
      { name: "status", description: t("lsp.sub_status") },
      { name: "restart", description: t("lsp.sub_restart") },
      { name: "doctor", description: t("lsp.sub_doctor") },
      { name: "check", description: t("lsp.sub_check") },
    ]),
  );
  host.completer.registerProvider(
    new SubcommandProvider("reasoning", [
      { name: "show", description: t("reasoning.sub_show") },
      { name: "hide", description: t("reasoning.sub_hide") },
      { name: "level", description: t("reasoning.sub_level") },
    ]),
  );
  host.completer.registerProvider(
    new SubcommandProvider("verbose", [
      { name: "quiet", description: t("verbose.sub_quiet") },
      { name: "normal", description: t("verbose.sub_normal") },
      { name: "verbose", description: t("verbose.sub_verbose") },
    ]),
  );
  host.completer.registerProvider(
    new SubcommandProvider("security", [
      { name: "status", description: t("cli.security.status") },
    ]),
  );
  host.completer.registerProvider(new ConfigKeyProvider());
  host.completer.registerProvider(new ConfigValueProvider());
  host.completer.registerProvider(new FlagProvider());
  host.completer.registerProvider(
    new CommandArgProvider(() =>
      Array.from(host.commands.entries())
        .filter(([key, cmd]) => key === cmd.name)
        .map(([, cmd]) => cmd.name),
    ),
  );
  const entryLabels = host.config.provider?.entries?.map((e) => e.label || e.type) ?? [];
  if (entryLabels.length > 0) {
    host.completer.registerProvider(new ProviderArgProvider(entryLabels));
  }
  host.completer.registerProvider(new ModelArgProvider(() => host.modelCache));
  // Комплит путей якорится на workspace агента, а не process.cwd().
  host.completer.registerProvider(new FilePathProvider(host.baseDir));
  // Греем кеш моделей фоном (бесплатный listModels-вызов).
  refreshModelCache(host);
}

/**
 * Фоновое обновление кешированного списка моделей для `/model use <Tab>`.
 * Best-effort: при провале кеш хранит прошлое содержимое.
 */
export function refreshModelCache(host: ReplCompleterHost): void {
  void (async () => {
    try {
      const name =
        host.config.provider.active ||
        host.config.provider.entries?.[0]?.label ||
        host.config.provider.type;
      const provider = host.agent.getProviderFor(name);
      if (!provider) return;
      const models = await provider.listModels();
      if (models.length > 0) {
        host.modelCache = models.sort();
      }
    } catch {
      // keep previous cache
    }
  })();
}
