// Реестр плагинов: регистрация с дедупом по версии, вкл/выкл и плоские записи.
// Диспатчер хуков живёт отдельно (`dispatch.ts`) — здесь только состояние.
import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { semverGt } from "../updater/checker";
import { Logger } from "../../logger/app-logger";
import { PluginDispatcher } from "./dispatch";
import { PluginLoader, invalidateModuleCache } from "./loader";
import {
  buildRecord,
  firstLine,
  validatePluginMeta,
  type PluginLoadFailure,
  type PluginRecord,
} from "./records";
import { isInsideDir } from "../../tools/path-utils";

const logger = new Logger("warn", "plugins");

/**
 * Итог регистрации: `registered` (встал/заменил), `skipped_older` (дедуп по
 * версии), `invalid` (метаданные не прошли проверку), `duplicate` (не
 * возвращается — оставлен для совместимости потребителей типа).
 */
export type RegisterResult =
  | { status: "registered"; warnings?: string[] }
  | { status: "skipped_older"; existing: AgentPlugin }
  | { status: "invalid"; errors: string[] }
  | { status: "duplicate" };

/** Плагин с источником загрузки (для показа в REPL/CLI). */
export interface PluginInfo {
  plugin: AgentPlugin;
  source?: "builtin" | "global" | "project";
}

/** Итог перезагрузки каталога плагинов. */
export interface ReloadReport {
  /** Выгружено плагинов (ушли из реестра, ресурсы освобождены). */
  unloaded: number;
  /** Загружено заново. */
  loaded: number;
  /** Не удалось перечитать (ошибка импорта или несовместимость). */
  failed: number;
  /** Файлы `.ts` под Node: кэш модуля не сбрасывается, нужен рестарт. */
  staleTs: number;
}

/** Каталоги, из которых менеджер читает внешние плагины. */
export interface PluginDirs {
  globalPluginsDir: string;
  projectPluginsDir: string;
}

/**
 * Перезагрузить оба каталога: выгрузить внешние плагины (с `onUnload`), сбросить
 * кэш модулей, прочитать заново.
 *
 * Живёт здесь, а не в отдельном сервисе, потому что каталоги известны только
 * bootstrap'у, а перезагружать должны все три поверхности (CLI, REPL, веб) —
 * иначе каждая завела бы свою копию этого кода.
 */
export function reloadPluginDirs(
  pluginManager: PluginManager,
  dirs: PluginDirs,
  options?: { mmaVersion?: string },
  logger?: { warn: (msg: string) => void },
): ReloadReport {
  const loader = new PluginLoader();
  const loaded = (dir: string, source: "global" | "project") =>
    loader.reloadFromDir(dir, pluginManager, logger, { source, mmaVersion: options?.mmaVersion });
  const global = loaded(dirs.globalPluginsDir, "global");
  const project = loaded(dirs.projectPluginsDir, "project");
  return {
    unloaded: global.unloaded + project.unloaded,
    loaded: global.loaded + project.loaded,
    failed: global.failed + project.failed,
    staleTs: global.staleTs + project.staleTs,
  };
}

/**
 * Выгрузить внешние плагины и сбросить кэш модулей **без** чтения заново.
 *
 * Нужно перед полной пересборкой bootstrap (`/reload` в REPL): bootstrap создаёт
 * новый `PluginManager`, и старые плагины без `onUnload` тихо пережили бы
 * пересборку вместе со своими серверами. Заодно сбрасываем кэш — иначе новый
 * bootstrap получил бы прежние версии файлов из `require`.
 */
export function unloadPluginsForReboot(
  pluginManager: PluginManager,
  dirs: PluginDirs,
  logger?: { warn: (msg: string) => void },
): string[] {
  const loader = new PluginLoader();
  const unloaded: string[] = [];
  for (const dir of [dirs.globalPluginsDir, dirs.projectPluginsDir]) {
    for (const { path } of loader.entryFiles(dir, logger)) invalidateModuleCache(path, logger);
    unloaded.push(...pluginManager.unloadByDir(dir));
  }
  pluginManager.clearFailures();
  return unloaded;
}

/** Реестр плагинов: дедуп, вкл/выкл, записи, диспетчер. */
export class PluginManager {
  private plugins: AgentPlugin[] = [];
  private disabled = new Set<string>();
  private loadedAt = new Map<string, number>();
  private failures: PluginLoadFailure[] = [];
  /** Кэш плоских записей; инвалидируется на любое изменение реестра. */
  private recordsCache: PluginRecord[] | null = null;
  private dispatcher = new PluginDispatcher(() => this.active());
  /** Каталоги для `reload()`; ставит bootstrap. */
  private dirs?: PluginDirs;
  /** Версия MMA для гейта `minMmaVersion` при перезагрузке. */
  private mmaVersion?: string;

  /**
   * Сообщить менеджеру, откуда он читает внешние плагины — чтобы `reload()`
   * не зависел от вызывающего (у CLI, REPL и веба каталоги одинаковые).
   */
  setSourceDirs(dirs: PluginDirs, mmaVersion?: string): void {
    this.dirs = dirs;
    this.mmaVersion = mmaVersion;
  }

  /** Перечитать оба каталога (см. `reloadPluginDirs`). */
  reload(): ReloadReport {
    if (!this.dirs) return { unloaded: 0, loaded: 0, failed: 0, staleTs: 0 };
    return reloadPluginDirs(this, this.dirs, { mmaVersion: this.mmaVersion });
  }

  /**
   * Регистрирует host-мост (ставит REPL один раз). Подмешивается в каждый
   * хук-контекст как `ctx.hostBridge`, если вызывающий не дал свой.
   */
  setHostBridge(bridge: HostBridge): void {
    this.dispatcher.setHostBridge(bridge);
  }

  /**
   * Регистрирует плагин. Одноимённые дедупятся — побеждает старшая `version`
   * (безверсейные считаются "0.0.0"). Проигравший отбрасывается; `skipped_older`
   * даёт вызывающему предупредить о выкинутой копии.
   *
   * Метаданные проверяются здесь: невалидное имя не регистрируется вовсе
   * (`errors`), мягкие замечания возвращаются в `warnings`, чтобы вызывающий
   * показал их один раз (в лог и в UI), а не на каждый ход.
   */
  register(plugin: AgentPlugin, source?: "builtin" | "global" | "project"): RegisterResult {
    const meta = validatePluginMeta(plugin);
    if (meta.errors.length > 0) return { status: "invalid", errors: meta.errors };
    if (source) plugin.source = source;
    const existing = this.plugins.find((p) => p.name === plugin.name);
    if (existing) {
      if (semverGt(plugin.version || "0.0.0", existing.version || "0.0.0")) {
        this.replace(existing, plugin);
        return { status: "registered", warnings: meta.warnings };
      }
      return { status: "skipped_older", existing };
    }
    this.plugins.push(plugin);
    this.touch(plugin);
    return { status: "registered", warnings: meta.warnings };
  }

  /** Заменить плагин на новую версию, сохранив позицию по приоритету. */
  private replace(existing: AgentPlugin, next: AgentPlugin): void {
    const index = this.plugins.indexOf(existing);
    this.plugins[index] = next;
    this.touch(next);
  }

  private touch(plugin: AgentPlugin): void {
    this.loadedAt.set(plugin.name, Date.now());
    this.sort();
    this.recordsCache = null;
  }

  private sort(): void {
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /** Снять плагина с регистрации (вызывающий сам решает про `onUnload`). */
  unregister(name: string): boolean {
    const index = this.plugins.findIndex((p) => p.name === name);
    if (index < 0) return false;
    this.plugins.splice(index, 1);
    this.loadedAt.delete(name);
    this.recordsCache = null;
    return true;
  }

  /**
   * Выгрузить внешние плагины, лежащие внутри каталога, и вызвать у них
   * `onUnload` — без него перезагрузка течёт сокетами (встроенные плагины из
   * реестра не трогаем: их код не перечитывается).
   */
  unloadByDir(dir: string, ctx?: unknown): string[] {
    const names: string[] = [];
    for (const plugin of [...this.plugins]) {
      if (!plugin.path || !isInsideDir(plugin.path, dir)) continue;
      safeUnload(plugin, ctx);
      this.unregister(plugin.name);
      names.push(plugin.name);
    }
    return names;
  }

  /**
   * Включает/выключает плагин без перезагрузки. Выключенный не участвует в
   * диспатчерах, но остаётся видимым в списках — иначе непонятно, что включать
   * обратно.
   *
   * Имя из deny-list можно выключить и до загрузки: плагин, который придёт
   * позже, сразу окажется выключенным (значение читается на каждой рассылке).
   * Возвращает `false`, если плагина сейчас нет в реестре.
   *
   * Честное ограничение: модуль уже `require`-нут, код верхнего уровня уже
   * выполнился. Disable останавливает поведение, а не исполнение импорта.
   */
  setEnabled(name: string, on: boolean): boolean {
    const loaded = this.plugins.some((p) => p.name === name);
    if (on) this.disabled.delete(name);
    else this.disabled.add(name);
    this.recordsCache = null;
    return loaded;
  }

  /**
   * Заменить deny-list целиком (путь конфига). Выключает перечисленные,
   * включает всё остальное. Неизвестные имена сохраняются — иначе запись
   * потерялась бы при первом же сохранении конфига без плагина на диске.
   */
  setDisabledAll(names: string[]): void {
    this.disabled = new Set(names.filter(Boolean));
    this.recordsCache = null;
  }

  isEnabled(name: string): boolean {
    return this.plugins.some((p) => p.name === name) && !this.disabled.has(name);
  }

  /** Имена выключенных плагинов (для `/config plugins.disabled` и UI). */
  getDisabled(): string[] {
    return [...this.disabled].sort();
  }

  /** Заметить непрогрузившийся плагин (сейчас он просто исчезал из списков). */
  noteFailure(entry: string, path: string, message: string): void {
    this.failures.push({ entry, path, message: firstLine(message), at: Date.now() });
    this.recordsCache = null;
  }

  /** Отказы загрузки (`entry`, путь, причина) для UI и `mma plugins list`. */
  getFailures(): PluginLoadFailure[] {
    return this.failures.map((f) => ({ ...f }));
  }

  /** Сбросить накопленные отказы — перезагрузка пересобирает список заново. */
  clearFailures(): void {
    this.failures = [];
    this.recordsCache = null;
  }

  /**
   * Активные плагины в порядке приоритета — единственная точка фильтрации.
   * От неё зависят все диспатчеры и `getAllPlugins`, поэтому выключение одного
   * плагина не требует правок в 15 хуках.
   */
  private active(): AgentPlugin[] {
    if (this.disabled.size === 0) return [...this.plugins];
    return this.plugins.filter((p) => !this.disabled.has(p.name));
  }

  /** Все зарегистрированные плагины (копия, по приоритету). */
  getAllPlugins(): AgentPlugin[] {
    return this.active();
  }

  /**
   * Плоские записи плагинов для всех поверхностей (CLI/REPL/веб). Кэшируются и
   * инвалидируются на любое изменение реестра — вызывающие просто читают.
   */
  getRecords(): PluginRecord[] {
    if (!this.recordsCache) {
      this.recordsCache = this.plugins.map((plugin) =>
        buildRecord(plugin, {
          enabled: !this.disabled.has(plugin.name),
          ...(this.loadedAt.has(plugin.name) ? { loadedAt: this.loadedAt.get(plugin.name) } : {}),
        }),
      );
    }
    return this.recordsCache.map((r) => ({ ...r }));
  }

  /** Детальный список (имя, версия, источник) для показа в REPL/CLI. */
  getPluginInfos(): PluginInfo[] {
    return [...this.plugins].map((plugin) => ({ plugin, source: plugin.source }));
  }

  /** Ищет зарегистрированный плагин по имени; null, если нет. */
  getPlugin(name: string): AgentPlugin | null {
    return this.plugins.find((p) => p.name === name) ?? null;
  }

  runOnBuildPrompt(): (string | null)[] {
    return this.dispatcher.runOnBuildPrompt();
  }

  runOnBeforeTool(rawCtx: any, call: ToolCall): Promise<boolean> {
    return this.dispatcher.runOnBeforeTool(rawCtx, call);
  }

  runOnAfterTool(rawCtx: any, call: ToolCall, result: ToolResult): Promise<void> {
    return this.dispatcher.runOnAfterTool(rawCtx, call, result);
  }

  runOnError(rawCtx: any, error: Error): Promise<void> {
    return this.dispatcher.runOnError(rawCtx, error);
  }

  runOnSessionStart(rawCtx: any): void {
    this.dispatcher.runOnSessionStart(rawCtx);
  }

  runOnBeforeThink(rawCtx: any): void {
    this.dispatcher.runOnBeforeThink(rawCtx);
  }

  runOnAfterThink(rawCtx: any, response: LLMResponse | null): void {
    this.dispatcher.runOnAfterThink(rawCtx, response);
  }

  runOnSessionEnd(rawCtx: any): void {
    this.dispatcher.runOnSessionEnd(rawCtx);
  }

  runOnToolCall(rawCtx: any): void {
    this.dispatcher.runOnToolCall(rawCtx);
  }

  runOnPhase(rawCtx: any, phase: AgentPhase): void {
    this.dispatcher.runOnPhase(rawCtx, phase);
  }

  runOnToolStart(rawCtx: any, call: ToolCall): void {
    this.dispatcher.runOnToolStart(rawCtx, call);
  }

  runOnToolEnd(rawCtx: any, call: ToolCall, result: ToolResult, durationMs: number): void {
    this.dispatcher.runOnToolEnd(rawCtx, call, result, durationMs);
  }

  runOnText(rawCtx: any, chunk: string): string {
    return this.dispatcher.runOnText(rawCtx, chunk);
  }

  runOnMeta(rawCtx: any, chunk: string): string {
    return this.dispatcher.runOnMeta(rawCtx, chunk);
  }

  runOnTurnEnd(rawCtx: any, summary: TurnSummary): void {
    this.dispatcher.runOnTurnEnd(rawCtx, summary);
  }
}

/** Вызов `onUnload` с той же изоляцией ошибок, что и у остальных хуков. */
function safeUnload(plugin: AgentPlugin, ctx?: unknown): void {
  if (!plugin.onUnload) return;
  try {
    const out = plugin.onUnload(ctx);
    if (out instanceof Promise) {
      out.catch((e: unknown) => {
        logger.warn(`plugin "${plugin.name}" onUnload rejected`, { error: String(e) });
      });
    }
  } catch (e) {
    logger.warn(`plugin "${plugin.name}" onUnload threw`, { error: String(e) });
  }
}
