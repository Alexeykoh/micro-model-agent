// Тема чата: глифы, болтливость, акцентные цвета категорий тулов (см. STYLE.md).
import { pc } from "./colors";

/**
 * Канонические глифы чата — единственный источник правды.
 * См. `docs/design/ui/STYLE.md`. Свои маркеры по модулям не выдумывать.
 */
export const glyph = {
  /** Действие (дальше — локализованный ярлык тула). */
  action: "◇",
  success: "✓",
  failure: "✗",
  warning: "⚠",
  /** Рассуждение / обдумывание. */
  thinking: "✦",
  question: "?",
  /** Эхо ввода пользователя в транскрипте. */
  user: "↵",
  /** Деталь или хинт восстановления. */
  detail: "↳",
  /** Продолжение сгруппированного прогона. */
  group: "│",
  /** Строка сводных метрик. */
  metric: "⟡",
  /** Компакция / обновление. */
  compact: "⟳",
} as const;

/** Глиф чата (одно из значений glyph). */
export type Glyph = (typeof glyph)[keyof typeof glyph];

/**
 * Сколько вывода чата хочет юзер.
 * - `quiet` (дефолт): строка на действие, метрики раз за ход;
 * - `normal`: плюс короткие сводки результатов;
 * - `verbose`: полные детали каждого действия.
 */
export type Verbosity = "quiet" | "normal" | "verbose";

/** Тайпгард болтливости. */
export function isVerbosity(value: unknown): value is Verbosity {
  return value === "quiet" || value === "normal" || value === "verbose";
}

/**
 * Резолвит итоговую болтливость из конфига. Явный `verbosity` побеждает;
 * иначе legacy-bool `verbose` маппится в `verbose`/`quiet`.
 */
export function resolveVerbosity(ui?: {
  verbose?: boolean;
  verbosity?: Verbosity;
}): Verbosity {
  if (ui?.verbosity) return ui.verbosity;
  return ui?.verbose ? "verbose" : "quiet";
}

/** Акцентная метка действия (cyan). */
export function actionMark(): string {
  return pc.cyan(glyph.action);
}

/** Категории тулов: форма глифа одна, вид кодируется цветом. */
export type ToolCategory = "recon" | "mutate" | "execute" | "meta";

const CATEGORY_TOOLS: Record<ToolCategory, ReadonlySet<string>> = {
  recon: new Set([
    "read_file",
    "list_dir",
    "glob",
    "grep",
    "file_info",
    "project_map",
    "chunk_query",
    "web_search",
    "web_fetch",
    "web_browse",
    "search_history",
    "recall",
    "session_info",
    "process_list",
    "process_log",
    "process_wait",
  ]),
  mutate: new Set([
    "write_file",
    "edit_file",
    "create_dir",
    "delete_file",
    "move_file",
    "attach_image",
  ]),
  execute: new Set([
    "bash",
    "process_kill",
    "pipeline_run",
    "browser",
    "download_file",
    "subagent",
    "mcp_call",
  ]),
  meta: new Set([
    "plan",
    "plan_step",
    "todo",
    "verify",
    "lsp_check",
    "enable_tools",
    "set_thinking",
    "load_skill",
    "remember",
  ]),
};

/** Категория тула по имени. Неизвестные — meta. */
export function toolCategory(tool: string): ToolCategory {
  for (const [category, tools] of Object.entries(CATEGORY_TOOLS) as [
    ToolCategory,
    ReadonlySet<string>,
  ][]) {
    if (tools.has(tool)) return category;
  }
  return "meta";
}

/**
 * Акцентный цвет категории тула. Один цвет красит И глиф действия, И
 * локализованный ярлык — они читаются как единое целое
 * (см. `docs/design/ui/STYLE.md`). Цвета не пересекаются с семантическими
 * success/warning/error, чтобы цветной ярлык не читался как исход.
 */
export function toolAccent(tool: string): (text: string) => string {
  switch (toolCategory(tool)) {
    case "recon":
      return pc.cyan;
    case "mutate":
      return pc.magenta;
    case "execute":
      return pc.blue;
    default:
      return pc.dim;
  }
}

/** Метка действия в цвете категории тула. */
export function actionMarkFor(tool: string): string {
  return toolAccent(tool)(glyph.action);
}

/** Зелёная метка успеха. */
export function successMark(): string {
  return pc.green(glyph.success);
}

/** Красная метка провала — только реальные сбои, не мягкие гарды. */
export function failureMark(): string {
  return pc.red(glyph.failure);
}

/** Жёлтая метка предупреждения — мягкие блоки, защищённые пути, нефатальное. */
export function warningMark(): string {
  return pc.yellow(glyph.warning);
}

/** Dim-метка детали/хинта. */
export function detailMark(): string {
  return pc.dim(glyph.detail);
}

/** Человеческая длительность: `ms` до секунды, `s` выше (как в мокапе). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
