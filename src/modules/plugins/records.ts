// Read-модель плагина для всех поверхностей (CLI/REPL/веб) + валидация метаданных.
// Единый источник правды: PluginManager отдаёт `PluginRecord[]`, а `mma plugins list`,
// `/plugins` и веб-вкладка не собирают вид по полям сами (было — `enabled: true` хардкодом).
import type { AgentPlugin, PluginPermission } from "../types";

export type { PluginPermission, PluginProvides } from "../types";

/** Канонический набор декларируемых прав (валидация + порядок показа в UI). */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  "config:read",
  "fs:read",
  "fs:write",
  "process",
  "network",
  "session:write",
];

/** Плоский вид плагина для UI/CLI. Поля всегда присутствуют (кроме опциональных строк). */
export interface PluginRecord {
  name: string;
  version?: string;
  author?: string;
  description?: string;
  homepage?: string;
  source?: "builtin" | "global" | "project";
  builtin: boolean;
  /** Загружен из черновиковой (самоавторской) директории — вычисляется из пути. */
  draft: boolean;
  /** Выключен пользователем (`config.plugins.disabled`). */
  enabled: boolean;
  /** Абсолютный путь к файлу плагина (для внешних). */
  path?: string;
  loadedAt?: number;
  provides: { tools: string[]; hooks: string[] };
  permissions: PluginPermission[];
  /** Мягкие замечания валидации (пустой автор, длинное описание, …). */
  warnings: string[];
  /** Плагин не загрузился: краткая причина в одну строку. */
  error?: string;
}

/** Не загрузившийся плагин: сегодня он просто исчезал из всех списков. */
export interface PluginLoadFailure {
  /** Метка записи (`my-plugin/plugin.ts` или `foo.ts`). */
  entry: string;
  path: string;
  /** Причина в одну строку (первая строка сообщения импорта). */
  message: string;
  at: number;
}

/** Имя плагина: нижний регистр, точка/дефис/подчёркивание, до 64 символов. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER_RE = /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/;
const MAX_AUTHOR = 80;
const MAX_DESCRIPTION = 400;
const HOMEPAGE_RE = /^https?:\/\/\S+$/i;

/** Имена хуков в порядке объявления интерфейса — для «что добавляет плагин». */
const HOOK_NAMES = [
  "onBuildPrompt",
  "onBeforeTool",
  "onAfterTool",
  "onBeforeThink",
  "onAfterThink",
  "onToolCall",
  "onError",
  "onSessionStart",
  "onSessionEnd",
  "onPhase",
  "onToolStart",
  "onToolEnd",
  "onText",
  "onMeta",
  "onTurnEnd",
] as const;

/** Хуки, реализованные плагином (для UI). */
export function detectHooks(plugin: AgentPlugin): string[] {
  const hooks: string[] = [];
  const impl = plugin as unknown as Record<string, unknown>;
  for (const name of HOOK_NAMES) {
    if (typeof impl[name] === "function") hooks.push(name);
  }
  return hooks;
}

/** Права в каноническом порядке; неизвестные отбрасываются. */
export function sanitizePermissions(value: unknown): {
  permissions: PluginPermission[];
  unknown: string[];
} {
  if (!Array.isArray(value)) return { permissions: [], unknown: [] };
  const permissions: PluginPermission[] = [];
  const unknown: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    if ((PLUGIN_PERMISSIONS as readonly string[]).includes(raw)) {
      permissions.push(raw as PluginPermission);
    } else {
      unknown.push(raw);
    }
  }
  // порядок — канонический, без дублей (важно для стабильного показа и сравнения)
  const seen = new Set(permissions);
  return {
    permissions: PLUGIN_PERMISSIONS.filter((p) => seen.has(p)),
    unknown,
  };
}

/** Проверки по одному полю: каждая возвращает список замечаний или null. */
type FieldCheck = (plugin: AgentPlugin) => string | null;

const CHECKS: ReadonlyArray<[string, FieldCheck]> = [
  ["version", (p) => (p.version === undefined || isSemverLike(p.version) ? null : `version ${JSON.stringify(p.version)} is not semver-like`)],
  ["author", (p) => (p.author === undefined ? null : !p.author.trim() ? "author is empty" : p.author.length > MAX_AUTHOR ? `author is longer than ${MAX_AUTHOR} chars` : null)],
  ["description", (p) => (p.description === undefined || p.description.length <= MAX_DESCRIPTION ? null : `description is longer than ${MAX_DESCRIPTION} chars`)],
  ["homepage", (p) => (p.homepage === undefined || HOMEPAGE_RE.test(String(p.homepage)) ? null : `homepage ${JSON.stringify(p.homepage)} is not an http(s) URL`)],
  [
    "permissions",
    (p) => {
      const { unknown } = sanitizePermissions(p.permissions);
      return unknown.length > 0 ? `unknown permissions: ${unknown.join(", ")}` : null;
    },
  ],
];

function isSemverLike(version: unknown): boolean {
  return typeof version === "string" && SEMVER_RE.test(version.replace(/^v/, ""));
}

/**
 * Проверка метаданных плагина. `errors` — плагин не регистрируется (сейчас это
 * только невалидное имя), `warnings` — регистрируется, но пользователь видит
 * замечание в UI и один варн в лог. Отсутствие `author`/`description` — это
 * warning, а не ошибка: иначе сломались бы плагин из 8 строк и оба примера.
 */
export function validatePluginMeta(plugin: AgentPlugin): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  if (typeof plugin.name !== "string" || !NAME_RE.test(plugin.name)) {
    errors.push(`invalid name ${JSON.stringify(plugin.name)} (expected ${NAME_RE.source})`);
  }
  const warnings: string[] = [];
  for (const [, check] of CHECKS) {
    const problem = check(plugin);
    if (problem) warnings.push(problem);
  }
  return { errors, warnings };
}

/** Чистые значения (после санитизации) — в record попадают только они. */
function cleanStrings(plugin: AgentPlugin): {
  author?: string;
  description?: string;
  homepage?: string;
} {
  const author =
    typeof plugin.author === "string" && plugin.author.trim() && plugin.author.length <= MAX_AUTHOR
      ? plugin.author
      : undefined;
  const description =
    typeof plugin.description === "string" && plugin.description.length <= MAX_DESCRIPTION
      ? plugin.description
      : undefined;
  const homepage =
    typeof plugin.homepage === "string" && HOMEPAGE_RE.test(plugin.homepage)
      ? plugin.homepage
      : undefined;
  return { author, description, homepage };
}

/** Плагин из черновиковой директории — вычисляем из пути, без четвёртого `source`. */
function isDraftPath(path: string | undefined): boolean {
  if (!path) return false;
  return path.replace(/\\/g, "/").includes("/drafts/");
}

/** Собирает плоский вид плагина для UI/CLI. */
export function buildRecord(
  plugin: AgentPlugin,
  opts: { enabled: boolean; loadedAt?: number; error?: string },
): PluginRecord {
  const { author, description, homepage } = cleanStrings(plugin);
  const { permissions } = sanitizePermissions(plugin.permissions);
  const { warnings } = validatePluginMeta(plugin);
  const path = plugin.path;
  return {
    name: plugin.name,
    version: plugin.version,
    author,
    description,
    homepage,
    source: plugin.source,
    builtin: plugin.isBuiltin === true,
    draft: isDraftPath(path),
    enabled: opts.enabled,
    path,
    loadedAt: opts.loadedAt,
    provides: {
      tools: [...(plugin.provides?.tools ?? [])],
      hooks: [...(plugin.provides?.hooks ?? detectHooks(plugin))],
    },
    permissions,
    warnings,
    error: opts.error,
  };
}

/** Первая строка сообщения — для однострочного показа в UI. */
export function firstLine(message: string): string {
  const line = String(message).split("\n", 1)[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}
