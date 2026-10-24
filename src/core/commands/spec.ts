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

/** Запись каталога с i18n-ключами: строки резолвятся при каждом чтении. */
type CommandSpecDef = Omit<CommandSpec, "description" | "usage"> & {
  readonly descriptionKey: string;
  readonly usageKey?: string;
};


/**
 * Все команды агента. Порядок сохраняется в реестре и определяет вид `/help`
 * внутри группы (сортировка — по имени, группа задаётся полем `group`).
 */
const SPEC_DEFS: readonly CommandSpecDef[] = [
  // ── general ───────────────────────────────────────────────────────────────
  {
    name: "help",
    descriptionKey: "repl.help",
    usageKey: "repl.help_usage",
    examples: ["/help", "/help config"],
    group: "general",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "exit",
    descriptionKey: "repl.exit",
    aliases: ["quit", "q"],
    usageKey: "repl.exit_usage",
    group: "general",
  },
  {
    name: "clear",
    descriptionKey: "repl.clear",
    usageKey: "repl.clear_usage",
    group: "general",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "run",
    descriptionKey: "repl.run",
    usageKey: "repl.run_usage",
    group: "general",
  },
  {
    name: "image",
    descriptionKey: "repl.image",
    aliases: ["img"],
    usageKey: "repl.image_usage",
    group: "general",
  },
  {
    name: "new",
    descriptionKey: "repl.new",
    usageKey: "repl.new_usage",
    group: "general",
    surfaces: ["terminal", "tui", "web"],
  },

  // ── agent ─────────────────────────────────────────────────────────────────
  {
    name: "config",
    descriptionKey: "repl.config",
    usageKey: "repl.config_usage",
    examples: ["/config", "/config model", "/config reasoning.mode high", "/config reset ui.verbosity"],
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "status",
    descriptionKey: "repl.status",
    usageKey: "repl.status_usage",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "reasoning",
    descriptionKey: "repl.reasoning",
    usageKey: "repl.reasoning_usage",
    examples: ["/reasoning", "/reasoning show", "/reasoning level high"],
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "verbose",
    descriptionKey: "repl.verbose",
    usageKey: "repl.verbose_usage",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "model",
    descriptionKey: "repl.model",
    usageKey: "repl.model_usage",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "provider",
    descriptionKey: "repl.provider",
    usageKey: "repl.provider_usage",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "context",
    descriptionKey: "repl.context",
    usageKey: "repl.context_usage",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "security",
    descriptionKey: "repl.security",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "export",
    descriptionKey: "repl.export",
    usageKey: "repl.export_usage",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "memory",
    descriptionKey: "repl.memory_usage",
    usageKey: "repl.memory_usage",
    group: "agent",
    surfaces: ["terminal", "tui", "web"],
  },
  {
    name: "sessions",
    descriptionKey: "repl.sessions",
    usageKey: "repl.sessions_usage",
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
    descriptionKey: "repl.sysprompt_desc",
    usageKey: "repl.sysprompt_usage",
    examples: ["/sysprompt", "/sysprompt --full"],
    group: "agent",
  },
  {
    name: "doctor",
    descriptionKey: "repl.doctor",
    usageKey: "repl.doctor_usage",
    group: "agent",
  },
  {
    name: "map",
    descriptionKey: "repl.map",
    usageKey: "repl.map_usage",
    group: "agent",
  },
  {
    name: "lsp",
    descriptionKey: "repl.lsp",
    usageKey: "repl.lsp_usage",
    group: "agent",
  },
  {
    name: "skill",
    descriptionKey: "repl.skill",
    usageKey: "repl.skill_usage",
    group: "skill",
  },
  {
    name: "plugins",
    descriptionKey: "repl.plugins",
    usageKey: "repl.plugins_usage",
    group: "agent",
  },
  {
    name: "reload",
    descriptionKey: "repl.reload",
    usageKey: "repl.reload_usage",
    group: "agent",
  },
  {
    name: "wizard",
    descriptionKey: "repl.wizard",
    aliases: ["setup"],
    usageKey: "repl.wizard_usage",
    group: "agent",
  },
  {
    name: "meet",
    descriptionKey: "cli.meet",
    aliases: ["познакомимся"],
    usageKey: "repl.meet_usage",
    group: "agent",
  },
  {
    name: "init",
    descriptionKey: "repl.init",
    usageKey: "repl.init_usage",
    group: "agent",
  },

  // ── session ───────────────────────────────────────────────────────────────
  {
    name: "resume",
    descriptionKey: "repl.resume",
    aliases: ["use"],
    usageKey: "repl.resume_usage",
    group: "session",
  },
  {
    name: "rename",
    descriptionKey: "repl.rename",
    usageKey: "repl.rename_usage",
    group: "session",
  },
  {
    name: "delete",
    descriptionKey: "repl.delete",
    usageKey: "repl.delete_usage",
    group: "session",
  },
];

/**
 * Каталог на ТЕКУЩЕЙ локали. Строится на каждый вызов: иначе строки замерзают
 * на языке, активном при импорте модуля (locale ставится в `main()` позже,
 * чем импортируется `Repl`), и `/help`/комплитер не переводятся.
 */
export function buildCommandCatalog(): readonly CommandSpec[] {
  return SPEC_DEFS.map(({ descriptionKey, usageKey, ...spec }) => ({
    ...spec,
    description: t(descriptionKey),
    ...(usageKey === undefined ? {} : { usage: t(usageKey) }),
  }));
}
