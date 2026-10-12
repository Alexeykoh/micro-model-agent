// Вклад тулов, которые плагины отдают через `getToolDefinitions()`: сбор,
// санитизация имён, теги, provenance и синхронизация со всеми реестрами
// (главный + per-session клоны `mma web`).
//
// Живёт отдельно от `manager.ts` (правило #1: ≤300 строк) и по той же причине,
// по которой хуки вынесены в `dispatch.ts`: менеджер держит состояние реестра
// плагинов, а всё, что касается `ToolRegistry`, — это отдельная подсистема.
import type { AgentPlugin } from "../types";
import type { ToolDefinition, ToolResult } from "../../tools/types";
import type { ToolRegistry } from "../../tools/registry";
import { Logger } from "../../logger/app-logger";
import { detectHooks } from "./records";

const logger = new Logger("warn", "plugins");

/** Плейсхолдер владельца имени, занятого ядром (в сообщении — «the harness»). */
const CORE_OWNER = "<harness>";

/** Префикс тега плагина (`plugin:<name>`). */
const PLUGIN_TAG_PREFIX = "plugin:";

/**
 * Владелец имени по тегу в самом определении.
 *
 * Нужно не только для красоты: `buildRunnerRegistry` **клонирует** определения в
 * реестр сессии, и клон приходит без записи о владельце. Живой прогон показал
 * ровно это: клон виделся «занятым ядром», вклад плагина отбрасывался, а reload
 * не обновлял тул — старая копия продолжала работать. Тег переживает клонирование.
 */
function ownerByTag(def: ToolDefinition | undefined): string | undefined {
  for (const tag of def?.tags ?? []) {
    if (tag.startsWith(PLUGIN_TAG_PREFIX)) return tag.slice(PLUGIN_TAG_PREFIX.length);
  }
  return undefined;
}

/** Тег тула плагина: `plugin:<name>` — по нему тул узнаётся в UI и отчётах. */
export function pluginToolTag(plugin: string): string {
  return `${PLUGIN_TAG_PREFIX}${plugin}`;
}

/**
 * Имя тула в реестре: `plugin__<плагин>__<тул>` — по образцу `mcp__<server>__<tool>`
 * (`src/modules/mcp/module.ts`). Префикс снимает почти все коллизии с ядром
 * и делает происхождение тула видимым прямо в истории сессии.
 */
export function pluginToolName(plugin: string, tool: string): string {
  const safePlugin = plugin.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `plugin__${safePlugin}__${safeTool}`;
}

/** Почему тул плагина не попал в реестр. */
export interface PluginToolConflict {
  plugin: string;
  /** Имя тула как его объявил плагин (`-`, если не разобрать). */
  tool: string;
  reason: "conflict" | "invalid";
  detail: string;
}

/** Итог одной синхронизации реестра с набором активных плагинов. */
export interface PluginToolSyncResult {
  /** Тул, который появился в реестре (переустановлен существующий — `kept`). */
  added: string[];
  /** Тул, который снят: плагин выключен, выгружен или перестал его отдавать. */
  removed: string[];
  /** Тул, который остался, но был перерегистрирован (reload плагина). */
  kept: string[];
  conflicts: PluginToolConflict[];
}

interface PreparedTool {
  /** Имя в реестре (с префиксом плагина). */
  name: string;
  /** Плагин-владелец — им же заполняется `provides.tools`. */
  plugin: string;
  def: ToolDefinition;
}

/** Что именно внёс один плагин (или почему ничего). */
interface PluginContribution {
  tools: PreparedTool[];
  conflicts: PluginToolConflict[];
}

/** Что сейчас внёс каждый тул в конкретный реестр (provenance в обратную сторону). */
interface AppliedState {
  owner: Map<string, string>;
}

/**
 * Состояние по реестрам — вне менеджера: реестров может быть много (главный плюс
 * по одному на живую сессию веба), и у каждого свой набор уже внесённых тулов.
 * WeakMap, чтобы отпускать реестр вместе с раннером.
 */
const applied = new WeakMap<ToolRegistry, AppliedState>();

function stateOf(registry: ToolRegistry): AppliedState {
  let state = applied.get(registry);
  if (!state) {
    state = { owner: new Map() };
    applied.set(registry, state);
  }
  return state;
}

/** Тег плагина + `alwaysOn` по умолчанию: иначе `enable_tools` спрятал бы тул. */
function withPluginMeta(plugin: string, name: string, def: ToolDefinition): ToolDefinition {
  const tag = pluginToolTag(plugin);
  const tags = [...(def.tags ?? [])];
  if (!tags.includes(tag)) tags.push(tag);
  // `name` — с префиксом плагина: в реестре определение лежит под своим ключом.
  return {
    ...def,
    name,
    tags,
    alwaysOn: def.alwaysOn ?? true,
    handler: wrapPluginHandler(def.handler),
  };
}

/**
 * Нормализация результата тула плагина.
 *
 * Плагин пишется на JS и часто возвращает `{ output }` без `success` — а поле
 * обязательное, и без него тул честно выглядит упавшим (живой прогон: карточка
 * «ошибка», в логе нет `success`, Trace показывает `success: false`). Считаем
 * отсутствие `success` успехом и приводим `output` к строке — автору не нужно
 * помнить про служебные поля чужого контракта.
 */
function wrapPluginHandler(handler: ToolDefinition["handler"]): ToolDefinition["handler"] {
  return async (ctx, args) => {
    const raw: unknown = await handler(ctx, args);
    const result = (typeof raw === "string" ? { output: raw } : raw ?? {}) as Partial<ToolResult>;
    const output =
      typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
    return { ...result, success: result.success !== false, output } as ToolResult;
  };
}

/** Замечание к одному определению: почему оно не годится. */
function definitionProblem(def: ToolDefinition | undefined): string | null {
  if (!def || typeof def !== "object") return "not a tool definition";
  if (
    typeof def.name !== "string" ||
    !def.name.trim() ||
    typeof def.description !== "string" ||
    !def.parameters ||
    typeof def.parameters !== "object"
  ) {
    return "needs name, description and parameters";
  }
  // Живой прогон: без `handler` тул падал в рантайме с
  // `tool.handler is not a function` — диагностика приходит из определения.
  if (typeof def.handler !== "function") return "needs a handler(ctx, args) returning {output}";
  return null;
}

/** Прочитать `getToolDefinitions()`: падение метода не должно ронять харнесс. */
function readToolDefinitions(plugin: AgentPlugin): { list?: unknown[]; problem?: string } {
  if (typeof plugin.getToolDefinitions !== "function") return {};
  let raw: unknown;
  try {
    raw = plugin.getToolDefinitions.call(plugin);
  } catch (e) {
    logger.warn(`plugin "${plugin.name}" getToolDefinitions threw`, { error: String(e) });
    return {};
  }
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) return { problem: "getToolDefinitions() must return an array" };
  return { list: raw as unknown[] };
}

/** Собрать вклад одного плагина; исключения изоляция хуков (`safeInvoke`). */
function collectPluginTools(plugin: AgentPlugin): PluginContribution {
  const conflicts: PluginToolConflict[] = [];
  const tools: PreparedTool[] = [];
  const { list, problem } = readToolDefinitions(plugin);
  if (problem) {
    conflicts.push({ plugin: plugin.name, tool: "-", reason: "invalid", detail: problem });
    return { tools, conflicts };
  }
  if (!list) return { tools, conflicts };

  const seen = new Set<string>();
  for (const item of list) {
    const def = item as ToolDefinition | undefined;
    const label = typeof def?.name === "string" ? def.name : "-";
    const invalid = definitionProblem(def);
    if (invalid) {
      conflicts.push({ plugin: plugin.name, tool: label, reason: "invalid", detail: invalid });
      continue;
    }
    const name = pluginToolName(plugin.name, (def as ToolDefinition).name);
    if (seen.has(name)) {
      conflicts.push({
        plugin: plugin.name,
        tool: (def as ToolDefinition).name,
        reason: "invalid",
        detail: `duplicate tool name after sanitization (${name})`,
      });
      continue;
    }
    seen.add(name);
    tools.push({
      name,
      plugin: plugin.name,
      def: withPluginMeta(plugin.name, name, def as ToolDefinition),
    });
  }
  return { tools, conflicts };
}

/**
 * Проверить вклад одного плагина против реестра: занятое имя отбрасывает вклад
 * целиком, а не по одному тулу (половинчатый набор хуже, чем ничего).
 * Возвращает принятые тулы; конфликт — в `conflict`.
 */
function acceptContribution(
  plugin: AgentPlugin,
  contribution: PluginContribution,
  registry: ToolRegistry,
  state: AppliedState,
  desired: Map<string, PreparedTool>,
): { accepted: PreparedTool[]; conflict?: PluginToolConflict } {
  const accepted: PreparedTool[] = [];
  for (const tool of contribution.tools) {
    // Владелец имени: наш прошлый вклад, плагин раньше в этом проходе — или
    // кто-то чужой (ядро). Чужое имя не отбираем никогда.
    const owner = state.owner.get(tool.name) ?? desired.get(tool.name)?.plugin;
    const taken = owner ?? (registry.has(tool.name) ? CORE_OWNER : undefined);
    if (!taken || taken === plugin.name) {
      accepted.push(tool);
      continue;
    }
    return {
      accepted: [],
      conflict: {
        plugin: plugin.name,
        tool: tool.name,
        reason: "conflict",
        detail: `tool name already taken by ${taken === CORE_OWNER ? "the harness" : `"${taken}"`}`,
      },
    };
  }
  return { accepted };
}

/**
 * Собрать желаемый набор тулов по активным плагинам (без записи в реестр).
 * Возвращает конфликты отдельно — их показываем, а не роняем синхронизацию.
 */
function desiredFromPlugins(
  plugins: AgentPlugin[],
  registry: ToolRegistry,
  state: AppliedState,
): { desired: Map<string, PreparedTool>; conflicts: PluginToolConflict[] } {
  const desired = new Map<string, PreparedTool>();
  const conflicts: PluginToolConflict[] = [];

  // Всё, что в реестре помечено тегом плагина, — наше (в т.ч. клоны, доставленные
  // `buildRunnerRegistry`): за это отвечает снятие в `applyDesired`, иначе
  // выключенный плагин оставил бы свои тулы в реестре сессии навсегда.
  for (const tool of registry.getAll()) {
    const owner = ownerByTag(tool);
    if (owner) state.owner.set(tool.name, owner);
  }

  for (const plugin of plugins) {
    const contribution = collectPluginTools(plugin);
    // Любое замечание — мусор в определении или падение самого метода: вклад
    // отбрасывается целиком (см. контракт функции).
    const { accepted, conflict } =
      contribution.conflicts.length > 0
        ? { accepted: [], conflict: undefined }
        : acceptContribution(plugin, contribution, registry, state, desired);
    if (conflict) conflicts.push(conflict);
    conflicts.push(...contribution.conflicts);
    for (const tool of accepted) desired.set(tool.name, tool);
    // `provides.tools` заполняет ядро — так же, как `hooks` (вычисляется здесь).
    plugin.provides = {
      ...plugin.provides,
      hooks: detectHooks(plugin),
      tools: accepted.map((t) => t.name),
    };
  }
  return { desired, conflicts };
}

/** Записать желаемый набор в реестр: снять лишнее, внести/перерегистрировать нужное. */
function applyDesired(
  registry: ToolRegistry,
  state: AppliedState,
  desired: Map<string, PreparedTool>,
): { added: string[]; removed: string[]; kept: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];

  for (const name of [...state.owner.keys()]) {
    if (desired.has(name)) continue;
    registry.unregister(name);
    state.owner.delete(name);
    removed.push(name);
  }
  for (const [name, tool] of desired) {
    const before = state.owner.get(name);
    state.owner.set(name, tool.plugin);
    registry.upsert(tool.def, `plugin:${tool.plugin}`);
    if (before) kept.push(name);
    else added.push(name);
  }
  return { added, removed, kept };
}

/**
 * Синхронизировать реестр с набором активных плагинов: снять то, чего больше
 * нет, и внести/перерегистрировать то, что есть. Идемпотентна — вызывается на
 * каждое изменение реестра плагинов (регистрация, выключение, reload).
 */
export function syncPluginTools(
  plugins: AgentPlugin[],
  registry: ToolRegistry,
): PluginToolSyncResult {
  const state = stateOf(registry);
  const { desired, conflicts } = desiredFromPlugins(plugins, registry, state);
  const { added, removed, kept } = applyDesired(registry, state, desired);

  for (const conflict of conflicts) {
    logger.warn(
      `plugin "${conflict.plugin}" tool "${conflict.tool}" skipped: ${conflict.detail}`,
    );
  }
  return { added, removed, kept, conflicts };
}

/** Снять вклад плагинов с реестра (выгрузка/остановка раннера). */
export function detachPluginTools(registry: ToolRegistry): string[] {
  const state = applied.get(registry);
  if (!state) return [];
  const removed = [...state.owner.keys()];
  for (const name of removed) registry.unregister(name);
  applied.delete(registry);
  return removed;
}
