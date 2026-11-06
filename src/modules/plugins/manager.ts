// Фасад реестра плагинов: гейт вкл/выкл, плоские записи и публичный API.
// Состояние набора живёт в `manager-catalog.ts`, вклад тулов — в `manager-tools.ts`,
// хуки — в `manager-hooks.ts`, перезагрузка — в `manager-reload.ts`.
import type { AgentPlugin } from "../types";
import type { ToolRegistry } from "../../tools/registry";
import type { PluginToolSyncResult } from "./tools";
import type { PluginLoadFailure, PluginRecord } from "./records";
import { buildRecord } from "./records";
import { PluginCatalog } from "./manager-catalog";
import { PluginToolSync } from "./manager-tools";
import { PluginHooks } from "./manager-hooks";
import { reloadPluginDirs } from "./manager-reload";
import type { PluginDirs, PluginInfo, RegisterResult, ReloadReport } from "./manager-types";
import type { Logger } from "../../logger/app-logger";
import { createPluginLog, type PluginLog } from "./log";

export { reloadPluginDirs, unloadPluginsForReboot } from "./manager-reload";
export type { PluginDirs, PluginInfo, RegisterResult, ReloadReport } from "./manager-types";

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

/** Реестр плагинов: гейт, записи, тулы и хуки (см. `manager-*`). */
export class PluginManager extends PluginHooks {
  /** Логгер этого менеджера: свой на сессию, глобального «текущего» нет. */
  private readonly log: PluginLog;
  private readonly toolSync: PluginToolSync;
  private readonly catalog: PluginCatalog;

  constructor(logger?: Logger) {
    const log = createPluginLog(logger);
    super(log);
    this.log = log;
    this.toolSync = new PluginToolSync(() => this.active(), log);
    this.catalog = new PluginCatalog(
      {
        changed: () => this.afterChange(),
        toolsChanged: () => this.afterToolsChange(),
        recordsChanged: () => this.invalidateRecords(),
        broadcast: (plugin) => this.broadcastPlugin(plugin),
        broadcastRemoval: (name) => this.broadcastRemoval(name),
      },
      log,
    );
  }

  private gate: PluginGate = { names: new Set(), version: 0, peers: new Set([this]) };
  /** Кэш плоских записей; инвалидируется на любое изменение реестра. */
  private recordsCache: PluginRecord[] | null = null;
  private recordsVersion = -1;
  /** Разошёл ли мы гейт другому менеджеру: тогда инстансы получаем от него. */
  private followsGate = false;
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
    return this.toolSync.attach(registry);
  }

  /**
   * Отключить реестр и снять с него вклад плагинов. Вызывается при остановке
   * раннера: иначе менеджер держал бы реестр выключенной сессии и пытался бы
   * вносить в него тулы после reload.
   */
  detachToolRegistry(registry: ToolRegistry): void {
    this.toolSync.detach(registry);
  }

  /**
   * Починить вклад тулов у всех менеджеров, делящих гейт. Реестры у каждого
   * свои (клон сессии ≠ главный), а выключатель у них общий — иначе тумблер в
   * вебе погасил бы плагин только в главном агенте.
   */
  private syncGatePeers(): void {
    for (const peer of [...this.gate.peers]) {
      if (peer !== this) peer.toolSync.sync();
    }
  }

  /** Принять новый инстанс плагина из источника гейта (главного менеджера). */
  adoptPlugin(plugin: AgentPlugin): void {
    this.catalog.adopt(plugin);
  }

  /** Забыть плагин, выгруженный источником гейта (его файл исчез при reload). */
  forgetPlugin(name: string): void {
    this.catalog.unregister(name);
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
    return this.toolSync.getConflicts();
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
   * Регистрирует плагин: дедуп по версии, проверка метаданных, рассылка
   * делящим гейт (см. `PluginCatalog.register`).
   */
  register(plugin: AgentPlugin, source?: "builtin" | "global" | "project"): RegisterResult {
    return this.catalog.register(plugin, source);
  }

  /** Снять плагина с регистрации (вызывающий сам решает про `onUnload`). */
  unregister(name: string): boolean {
    return this.catalog.unregister(name);
  }

  /** Выгрузить внешние плагины внутри каталога с вызовом `onUnload`. */
  unloadByDir(dir: string, ctx?: unknown): string[] {
    return this.catalog.unloadByDir(dir, ctx);
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
    const plugin = this.catalog.find(name);
    // Системный хук модуля нельзя выключить: это не плагин, а часть харнесса.
    if (!on && plugin?.system) return false;
    if (on) this.gate.names.delete(name);
    else this.gate.names.add(name);
    this.bumpGate();
    return this.catalog.isRegistered(name);
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
    const system = this.catalog.systemNames();
    this.gate.names.clear();
    for (const name of names) if (name && !system.has(name)) this.gate.names.add(name);
    this.bumpGate();
  }

  /** Гейт изменился: сбросить кэш записей и пересобрать вклад тулов. */
  private bumpGate(): void {
    this.gate.version++;
    this.afterChange();
  }

  /** Набор плагинов изменился: записи, тулы и peers гейта. */
  private afterChange(): void {
    this.invalidateRecords();
    this.toolSync.sync();
    this.syncGatePeers();
  }

  /** Заменили инстанс: пересобрать только записи и тулы, без веера peers. */
  private afterToolsChange(): void {
    this.invalidateRecords();
    this.toolSync.sync();
  }

  /** Кэш записей невалиден (изменился набор плагинов или deny-list). */
  private invalidateRecords(): void {
    this.recordsCache = null;
  }

  isEnabled(name: string): boolean {
    return this.catalog.isRegistered(name) && !this.gate.names.has(name);
  }

  /** Имена выключенных плагинов (для `/config plugins.disabled` и UI). */
  getDisabled(): string[] {
    return [...this.gate.names].sort();
  }

  /** Заметить непрогрузившийся плагин (сейчас он просто исчезал из списков). */
  noteFailure(entry: string, path: string, message: string): void {
    this.catalog.noteFailure(entry, path, message);
  }

  /** Отказы загрузки (`entry`, путь, причина) для UI и `mma plugins list`. */
  getFailures(): PluginLoadFailure[] {
    return this.catalog.getFailures();
  }

  /** Сбросить накопленные отказы — перезагрузка пересобирает список заново. */
  clearFailures(): void {
    this.catalog.clearFailures();
  }

  /**
   * Активные плагины в порядке приоритета — единственная точка фильтрации.
   * От неё зависят все диспатчеры и `getAllPlugins`, поэтому выключение одного
   * плагина не требует правок в 15 хуках.
   */
  protected active(): AgentPlugin[] {
    return this.catalog.active(this.gate.names);
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
      this.recordsCache = this.catalog.all().map((plugin) => {
        const loadedAt = this.catalog.loadedAtOf(plugin.name);
        return buildRecord(plugin, {
          enabled: !this.gate.names.has(plugin.name),
          ...(loadedAt !== undefined ? { loadedAt } : {}),
        });
      });
      this.recordsVersion = this.gate.version;
    }
    return this.recordsCache.map((r) => ({ ...r }));
  }

  /** Детальный список (имя, версия, источник) для показа в REPL/CLI. */
  getPluginInfos(): PluginInfo[] {
    return [...this.catalog.all()].map((plugin) => ({ plugin, source: plugin.source }));
  }

  /** Ищет зарегистрированный плагин по имени; null, если нет. */
  getPlugin(name: string): AgentPlugin | null {
    return this.catalog.find(name);
  }
}
