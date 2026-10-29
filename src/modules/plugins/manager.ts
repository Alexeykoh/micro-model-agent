// Реестр плагинов: регистрация с дедупом по версии, вкл/выкл и плоские записи.
// Диспатчер хуков живёт отдельно (`dispatch.ts`) — здесь только состояние.
import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { semverGt } from "../updater/checker";
import { Logger } from "../../logger/app-logger";
import { PluginDispatcher } from "./dispatch";
import { PluginLoader, invalidateModuleCache } from "./loader";
import { syncPluginTools, detachPluginTools, type PluginToolSyncResult } from "./tools";
import {
  buildRecord,
  firstLine,
  validatePluginMeta,
  type PluginLoadFailure,
  type PluginRecord,
} from "./records";
import type { ToolRegistry } from "../../tools/registry";
import { isInsideDir } from "../../tools/path-utils";

const logger = new Logger("warn", "plugins");

/**
 * Общий deny-list. Живёт объектом, а не полем, чтобы per-session менеджеры веба
 * могли поделить **ссылку** с главным (`shareGateWith`): тогда тумблер в UI
 * выключает плагин во всех живых реестрах без веера вызовов, а `version`
 * инвалидирует кэш записей у всех менеджеров разом.
 */
interface PluginGate {
  names: Set<string>;
  version: number;
  /**
   * Менеджеры, делящие этот гейт (главный + живые раннеры веба). Нужен, чтобы
   * изменение из одного менеджера починило вклад тулов во **всех** реестрах:
   * тумблер в вебе выключает плагин и в главном агенте, и в клонах сессий.
   */
  peers: Set<PluginManager>;
}

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
  private gate: PluginGate = { names: new Set(), version: 0, peers: new Set([this]) };
  private loadedAt = new Map<string, number>();
  private failures: PluginLoadFailure[] = [];
  /** Кэш плоских записей; инвалидируется на любое изменение реестра. */
  private recordsCache: PluginRecord[] | null = null;
  private recordsVersion = -1;
  /** Реестры, в которые вносятся тулы плагинов (главный + живые раннеры). */
  private toolRegistries = new Set<ToolRegistry>();
  /** Разошёл ли мы гейт другому менеджеру: тогда инстансы получаем от него. */
  private followsGate = false;
  /** Конфликты последней синхронизации тулов — для `mma plugins show` и тестов. */
  private toolConflicts: PluginToolSyncResult["conflicts"] = [];
  private dispatcher = new PluginDispatcher(() => this.active());
  /** Каталоги для `reload()`; ставит bootstrap. */
  private dirs?: PluginDirs;
  /** Версия MMA для гейта `minMmaVersion` при перезагрузке. */
  private mmaVersion?: string;

  /** Поделить deny-list с раннер-клоном в вебе: source — вызвавший. */
  shareGateWith(other: PluginManager): void {
    this.gate.peers.delete(this);
    this.gate = other.gate;
    this.gate.peers.add(this);
    this.followsGate = true;
  }

  /**
   * Подключить реестр тулов к вкладу плагинов и сразу синхронизировать: реестр
   * мог быть собран до последней перезагрузки плагинов.
   */
  attachToolRegistry(registry: ToolRegistry): PluginToolSyncResult {
    this.toolRegistries.add(registry);
    return this.syncTools();
  }

  /**
   * Отключить реестр и снять с него вклад плагинов. Вызывается при остановке
   * раннера: иначе менеджер держал бы реестр выключенной сессии и пытался бы
   * вносить в него тулы после reload.
   */
  detachToolRegistry(registry: ToolRegistry): void {
    if (!this.toolRegistries.delete(registry)) return;
    detachPluginTools(registry);
  }

  /** Синхронизировать все подключённые реестры с текущим набором плагинов. */
  private syncTools(): PluginToolSyncResult {
    const result: PluginToolSyncResult = { added: [], removed: [], kept: [], conflicts: [] };
    for (const registry of this.toolRegistries) {
      const one = syncPluginTools(this.active(), registry);
      result.added.push(...one.added);
      result.removed.push(...one.removed);
      result.kept.push(...one.kept);
      result.conflicts.push(...one.conflicts);
    }
    this.toolConflicts = result.conflicts;
    return result;
  }

  /**
   * Починить вклад тулов у всех менеджеров, делящих гейт. Реестры у каждого
   * свои (клон сессии ≠ главный), а выключатель у них общий — иначе тумблер в
   * вебе погасил бы плагин только в главном агенте.
   */
  private syncGatePeers(): void {
    for (const peer of [...this.gate.peers]) {
      if (peer !== this) peer.syncTools();
    }
  }

  /**
   * Принять новый инстанс плагина из источника гейта (главного менеджера).
   *
   * Живой прогон вскрыл дыру: `reload` перечитывает плагин в главном
   * менеджере, а уже спавненная сессия веба держала **старый** инстанс — и его
   * хуки, и его тулы (правка `handler` в файле плагина не доезжала минуя рестарт).
   */
  adoptPlugin(plugin: AgentPlugin): void {
    const existing = this.plugins.find((p) => p.name === plugin.name);
    if (existing) {
      this.plugins[this.plugins.indexOf(existing)] = plugin;
      this.invalidateRecords();
      this.syncTools();
      return;
    }
    this.plugins.push(plugin);
    this.touch(plugin);
  }

  /** Забыть плагин, выгруженный источником гейта (его файл исчез при reload). */
  forgetPlugin(name: string): void {
    this.unregister(name);
  }

  /** Разослать новый инстанс тем, кто делит наш гейт (runner-кланы сессий). */
  private broadcastPlugin(plugin: AgentPlugin): void {
    if (this.followsGate) return;
    for (const peer of [...this.gate.peers]) {
      if (peer !== this) peer.adoptPlugin(plugin);
    }
  }

  /** Сообщить подписчикам гейта, что плагин ушёл (выгрузка/удаление файла). */
  private broadcastRemoval(name: string): void {
    if (this.followsGate) return;
    for (const peer of [...this.gate.peers]) {
      if (peer !== this) peer.forgetPlugin(name);
    }
  }

  /** Конфликты имён тулов последней синхронизации (пусто, если всё внеслось). */
  getToolConflicts(): PluginToolSyncResult["conflicts"] {
    return this.toolConflicts.map((c) => ({ ...c }));
  }

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
        this.broadcastPlugin(plugin);
        return { status: "registered", warnings: meta.warnings };
      }
      return { status: "skipped_older", existing };
    }
    this.plugins.push(plugin);
    this.touch(plugin);
    this.broadcastPlugin(plugin);
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
    this.invalidateRecords();
    this.syncTools();
    this.syncGatePeers();
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
    this.invalidateRecords();
    this.syncTools();
    this.syncGatePeers();
    this.broadcastRemoval(name);
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
    const plugin = this.plugins.find((p) => p.name === name);
    // Системный хук модуля нельзя выключить: это не плагин, а часть харнесса.
    if (!on && plugin?.system) return false;
    const loaded = this.plugins.some((p) => p.name === name);
    if (on) this.gate.names.delete(name);
    else this.gate.names.add(name);
    this.bumpGate();
    return loaded;
  }

  /**
   * Заменить deny-list целиком (путь конфига). Выключает перечисленные,
   * включает всё остальное. Неизвестные имена сохраняются — иначе запись
   * потерялась бы при первом же сохранении конфига без плагина на диске.
   *
   * Множество правится **на месте**: на нём может висеть общий gate раннеров
   * веба, и подмена объекта тихо оставила бы их со старым deny-list.
   */
  setDisabledAll(names: string[]): void {
    const system = new Set(this.plugins.filter((p) => p.system).map((p) => p.name));
    this.gate.names.clear();
    for (const name of names) if (name && !system.has(name)) this.gate.names.add(name);
    this.bumpGate();
  }

  /** Гейт изменился: сбросить кэш записей и пересобрать вклад тулов. */
  private bumpGate(): void {
    this.gate.version++;
    this.invalidateRecords();
    this.syncTools();
    this.syncGatePeers();
  }

  /** Кэш записей невалиден (изменился набор плагинов или deny-list). */
  private invalidateRecords(): void {
    this.recordsCache = null;
  }

  isEnabled(name: string): boolean {
    return this.plugins.some((p) => p.name === name) && !this.gate.names.has(name);
  }

  /** Имена выключенных плагинов (для `/config plugins.disabled` и UI). */
  getDisabled(): string[] {
    return [...this.gate.names].sort();
  }

  /** Заметить непрогрузившийся плагин (сейчас он просто исчезал из списков). */
  noteFailure(entry: string, path: string, message: string): void {
    this.failures.push({ entry, path, message: firstLine(message), at: Date.now() });
    this.invalidateRecords();
  }

  /** Отказы загрузки (`entry`, путь, причина) для UI и `mma plugins list`. */
  getFailures(): PluginLoadFailure[] {
    return this.failures.map((f) => ({ ...f }));
  }

  /** Сбросить накопленные отказы — перезагрузка пересобирает список заново. */
  clearFailures(): void {
    this.failures = [];
    this.invalidateRecords();
  }

  /**
   * Активные плагины в порядке приоритета — единственная точка фильтрации.
   * От неё зависят все диспатчеры и `getAllPlugins`, поэтому выключение одного
   * плагина не требует правок в 15 хуках.
   */
  private active(): AgentPlugin[] {
    if (this.gate.names.size === 0) return [...this.plugins];
    return this.plugins.filter((p) => !this.gate.names.has(p.name));
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
    // `gate.version` общий у мениджеров, делящих deny-list: смена выключателя
    // из веба должна чистить кэш и у раннеров тоже.
    if (!this.recordsCache || this.recordsVersion !== this.gate.version) {
      this.recordsCache = this.plugins.map((plugin) =>
        buildRecord(plugin, {
          enabled: !this.gate.names.has(plugin.name),
          ...(this.loadedAt.has(plugin.name) ? { loadedAt: this.loadedAt.get(plugin.name) } : {}),
        }),
      );
      this.recordsVersion = this.gate.version;
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
        logger.diagnostic("warn", `plugin "${plugin.name}" onUnload rejected`, { error: String(e) });
      });
    }
  } catch (e) {
    logger.diagnostic("warn", `plugin "${plugin.name}" onUnload threw`, { error: String(e) });
  }
}
