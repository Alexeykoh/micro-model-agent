// Общий формат листинга плагинов для CLI (`mma plugins`) и REPL (`/plugins`).
// Раньше обе поверхности дублировали строку `  {mark} {name}  v{ver}  [{origin}]`
// и ничего не знали про автора/описание/включённость.
import { pc } from "../../ui/colors";
import { t } from "../../i18n/index";
import type { PluginLoadFailure, PluginRecord } from "./records";
import type { PluginToolConflict } from "./tools";

/** Опции листинга. */
export interface PluginListOptions {
  /** Показывать встроенные плагины. */
  showBuiltin?: boolean;
  /** Версия MMA для заголовка. */
  mmaVersion?: string;
  /** Печатать dim-подсказку про скрытые встроенные (REPL). */
  hiddenHint?: number;
}

const DESCRIPTION_MAX = 90;

/** Обрезка описания под одну dim-строку. */
function clip(text: string): string {
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

/** Вторая строка: автор · права. */
function recordMeta(record: PluginRecord): string | null {
  const parts: string[] = [];
  if (record.author) parts.push(t("cli.plugins.by", { author: record.author }));
  if (record.permissions.length > 0) {
    parts.push(t("cli.plugins.perms", { perms: record.permissions.join(", ") }));
  }
  return parts.length > 0 ? pc.dim(parts.join(" · ")) : null;
}

/** Одна строка плагина: маркер · имя · версия · источник · состояние. */
function formatRecord(record: PluginRecord): string[] {
  const mark = record.builtin ? t("cli.plugins.builtin_mark") : " ";
  const head = [mark, record.name, `v${record.version || "-"}`, `[${record.source || "builtin"}]`].join("  ");
  const lines = [record.enabled ? head : `${pc.dim(head)} ${pc.dim(t("cli.plugins.off"))}`];
  const meta = recordMeta(record);
  if (meta) lines.push("    " + meta);
  if (record.description) lines.push("    " + pc.dim(clip(record.description)));
  if (record.provides.tools.length > 0) {
    lines.push("    " + pc.dim(t("cli.plugins.tools", { tools: record.provides.tools.join(", ") })));
  }
  for (const warning of record.warnings) {
    lines.push("    " + pc.yellow(t("plugin.meta_warning", { name: record.name, problem: warning })));
  }
  return lines;
}

/** Строка непрогрузившегося плагина: причина в одну строку (см. `firstLine`). */
function formatFailure(failure: PluginLoadFailure): string[] {
  return [
    `✗ ${failure.entry}`,
    "    " + pc.dim(t("cli.plugins.failed", { path: failure.path, message: failure.message })),
  ];
}

/**
 * Замечания, по которым плагин «не такой, как обещал»: мягкие предупреждения
 * метаданных и тулы, которые ядро не внесло (коллизия имён, мусор в
 * определении). Пользователь видит, почему вклад плагина не доехал.
 */
function noticeLines(record: PluginRecord, toolConflicts: PluginToolConflict[]): string[] {
  const lines: string[] = [];
  for (const warning of record.warnings) {
    lines.push("  " + pc.yellow(t("plugin.meta_warning", { name: record.name, problem: warning })));
  }
  for (const conflict of toolConflicts) {
    if (conflict.plugin !== record.name) continue;
    lines.push(
      "  " + pc.yellow(t("plugin.tool_conflict", { tool: conflict.tool, detail: conflict.detail })),
    );
  }
  return lines;
}

/** Подробности плагина для `mma plugins show` и поп-апа веба (текстовый вид). */
export function formatPluginDetails(
  record: PluginRecord,
  failures: PluginLoadFailure[],
  toolConflicts: PluginToolConflict[] = [],
): string[] {
  const lines: string[] = [];
  lines.push(`${record.name}  ${record.version ? `v${record.version}` : ""}`.trim());
  lines.push(
    "  " +
      t("cli.plugins.state", {
        enabled: record.enabled ? t("cli.plugins.on") : t("cli.plugins.off"),
        source: record.source || "builtin",
      }),
  );
  if (record.author) lines.push(`  ${t("cli.plugins.author")}: ${record.author}`);
  if (record.homepage) lines.push(`  ${t("cli.plugins.homepage")}: ${record.homepage}`);
  if (record.path) lines.push(`  ${t("cli.plugins.path")}: ${record.path}`);
  if (record.description) {
    lines.push("");
    lines.push(`  ${record.description}`);
  }
  if (record.permissions.length > 0) {
    lines.push(`  ${t("cli.plugins.perms_label")}: ${record.permissions.join(", ")}`);
  } else {
    lines.push("  " + pc.dim(t("cli.plugins.perms_none")));
  }
  if (record.provides.tools.length > 0) {
    lines.push(`  ${t("cli.plugins.tools_label")}: ${record.provides.tools.join(", ")}`);
  }
  if (record.provides.hooks.length > 0) {
    lines.push(`  ${t("cli.plugins.hooks_label")}: ${record.provides.hooks.join(", ")}`);
  }
  lines.push(...noticeLines(record, toolConflicts));
  const failure = failures.find((f) => f.path === record.path);
  if (failure) lines.push("  " + pc.red(failure.message));
  return lines;
}

/**
 * Полный листинг (строки для канала вывода). Пустой массив — показывать
 * `cli.plugins.none` вызывающему.
 */
export function formatPluginList(
  records: PluginRecord[],
  failures: PluginLoadFailure[],
  options: PluginListOptions = {},
): string[] {
  const shown = options.showBuiltin ? records : records.filter((r) => !r.builtin);
  const lines: string[] = [];
  if (shown.length === 0 && failures.length === 0 && (options.hiddenHint ?? 0) > 0) {
    // Встроенные загружены, но по умолчанию скрыты: «плагинов нет» — неправда,
    // которую видел пользователь рядом с `Plugins [ok] 10 active` в /doctor.
    lines.push(t("cli.plugins.none_external"));
  }
  if (shown.length > 0) {
    lines.push(
      t("cli.plugins.header", {
        count: String(shown.length),
        mma: options.mmaVersion || "-",
      }),
    );
    for (const record of shown) lines.push(...formatRecord(record));
  }
  if (failures.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(t("cli.plugins.failed_header", { count: String(failures.length) }));
    for (const failure of failures) lines.push(...formatFailure(failure));
  }
  if (options.hiddenHint !== undefined && options.hiddenHint > 0) {
    lines.push(
      pc.dim(
        "  " + t("repl.plugins_hidden", { count: String(options.hiddenHint) }),
      ),
    );
  }
  return lines;
}
