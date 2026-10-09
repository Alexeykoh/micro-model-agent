// Каталог slash-команд MMA: объявления всех команд и их доступность по фронтендам.
/**
 * Данная часть реестра команд (см. `catalog.ts`): ЧТО есть, а не КАК выполняется.
 * Описания/алиасы/usage/примеры и группы живут здесь; действия приклеивает
 * каждый фронтенд (`registerCommand` в терминале, `makeWebCommands` в вебе).
 *
 * `surfaces` отражает реальность: команда помечена `web`, только если у веба есть
 * свой хендлер (`webui/chat/commands*.ts`). Это переехало из рукописного списка
 * `HELP` в `mma web`, так что `/help` в браузере и комплитер в терминале больше
 * не расходятся (раньше каждый собирал свой список и правился вручную).
 *
 * Переводы резолвятся при объявлении (`t(...)`), поэтому смена локали требует
 * пересборки каталога — как и раньше при регистрации команд.
 */
import { t } from "../../i18n/index";
import type { CommandSpec } from "./catalog";

/**
 * Все команды агента. Порядок сохраняется в реестре и определяет вид `/help`
 * внутри группы (сортировка — по имени, группа задаётся полем `group`).
 */
export const COMMAND_CATALOG: readonly CommandSpec[] = [
  // ── general ───────────────────────────────────────────────────────────────
  {
    name: "help",
    description: t("repl.help"),
    usage: t("repl.help_usage"),
    examples: ["/help", "/help config"],
    group: "general",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "exit",
    description: t("repl.exit"),
    aliases: ["quit", "q"],
    usage: t("repl.exit_usage"),
    group: "general",
  },
  {
    name: "clear",
    description: t("repl.clear"),
    usage: t("repl.clear_usage"),
    group: "general",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "run",
    description: t("repl.run"),
    usage: t("repl.run_usage"),
    group: "general",
  },
  {
    name: "image",
    description: t("repl.image"),
    aliases: ["img"],
    usage: t("repl.image_usage"),
    group: "general",
  },
  {
    name: "new",
    description: t("repl.new"),
    usage: t("repl.new_usage"),
    group: "general",
    surfaces: ["terminal", "tui", "web"],
  },

  // ── agent ─────────────────────────────────────────────────────────────────
  {
    name: "config",
    description: t("repl.config"),
    usage: t("repl.config_usage"),
    examples: ["/config", "/config model", "/config reasoning.mode high", "/config reset ui.verbosity"],
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "status",
    description: t("repl.status"),
    usage: t("repl.status_usage"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "reasoning",
    description: t("repl.reasoning"),
    usage: t("repl.reasoning_usage"),
    examples: ["/reasoning", "/reasoning show", "/reasoning level high"],
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "verbose",
    description: t("repl.verbose"),
    usage: t("repl.verbose_usage"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "model",
    description: t("repl.model"),
    usage: t("repl.model_usage"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "provider",
    description: t("repl.provider"),
    usage: t("repl.provider_usage"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "context",
    description: t("repl.context"),
    usage: t("repl.context_usage"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "security",
    description: t("repl.security"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "export",
    description: t("repl.export"),
    usage: t("repl.export_usage"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "memory",
    description: t("repl.memory_usage"),
    usage: t("repl.memory_usage"),
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "sessions",
    description: t("repl.sessions"),
    usage: t("repl.sessions_usage"),
    group: "agent",
    // Имя в браузере отличается: веб отдаёт `/session list|use` (см.
    // `webui/settings/commands-settings.ts`), терминал — `/sessions` для
    // списка и `/resume` для выбора. Единственное расхождение имён между
    // фронтендами, поэтому объявлено явно, а не спрятано в двух реестрах.
    webName: "session",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "sysprompt",
    description: t("repl.sysprompt_desc"),
    usage: t("repl.sysprompt_usage"),
    examples: ["/sysprompt", "/sysprompt --full"],
    group: "agent",
  },
  {
    name: "map",
    description: t("repl.map"),
    usage: t("repl.map_usage"),
    group: "agent",
  },
  {
    name: "lsp",
    description: t("repl.lsp"),
    usage: t("repl.lsp_usage"),
    group: "agent",
  },
  {
    name: "skill",
    description: t("repl.skill"),
    usage: t("repl.skill_usage"),
    group: "skill",
  },
  {
    name: "plugins",
    description: t("repl.plugins"),
    usage: t("repl.plugins_usage"),
    group: "agent",
  },
  {
    name: "reload",
    description: t("repl.reload"),
    usage: t("repl.reload_usage"),
    group: "agent",
  },
  {
    name: "wizard",
    description: t("repl.wizard"),
    aliases: ["setup"],
    usage: t("repl.wizard_usage"),
    group: "agent",
  },
  {
    name: "meet",
    description: t("cli.meet"),
    aliases: ["познакомимся"],
    usage: t("repl.meet_usage"),
    group: "agent",
  },
  {
    name: "init",
    description: t("repl.init"),
    usage: t("repl.init_usage"),
    group: "agent",
  },

  // ── session ───────────────────────────────────────────────────────────────
  {
    name: "resume",
    description: t("repl.resume"),
    aliases: ["use"],
    usage: t("repl.resume_usage"),
    group: "session",
  },
  {
    name: "rename",
    description: t("repl.rename"),
    usage: t("repl.rename_usage"),
    group: "session",
  },
  {
    name: "delete",
    description: t("repl.delete"),
    usage: t("repl.delete_usage"),
    group: "session",
  },
];