// Каталог плагинов: набор, дедуп по версии, загрузка/выгрузка и отказы.
// Вынесен из `manager.ts` (правило 6): здесь только состояние реестра плагинов,
// а гейт, тулы, записи и хуки остаются у фасада `PluginManager`.
import type { AgentPlugin } from "../types";
import { semverGt } from "../updater/checker";
import { Logger } from "../../logger/app-logger";
import { firstLine, validatePluginMeta, type PluginLoadFailure } from "./records";
import { isInsideDir } from "../../tools/path-utils";
import type { RegisterResult } from "./manager-types";

const logger = new Logger("warn", "plugins");

/** События каталога, на которые реагирует фасад (кэш, тулы, peers гейта). */
export interface CatalogObserver {
  /** Изменился набор: сбросить записи, пересобрать тулы, починить peers. */
  changed(): void;
  /** Заменили инстанс (`adopt`): пересобрать только вклад тулов. */
  toolsChanged(): void;
  /** Изменились только отказы загрузки: сбросить кэш записей. */
  recordsChanged(): void;
  /** Новый/заменённый инстанс — разослать делящим гейт. */
  broadcast(plugin: AgentPlugin): void;
  /** Плагин ушёл — разослать делящим гейт. */
  broadcastRemoval(name: string): void;
}

/** Реестр плагинов: дедуп по версии, загрузка/выгрузка, отказы. */
export class PluginCatalog {
  private readonly plugins: AgentPlugin[] = [];
  private readonly loadedAt = new Map<string, number>();
  private failures: PluginLoadFailure[] = [];

  constructor(private readonly observer: CatalogObserver) {}

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
        this.observer.broadcast(plugin);
        return { status: "registered", warnings: meta.warnings };
      }
      return { status: "skipped_older", existing };
    }
    this.plugins.push(plugin);
    this.touch(plugin);
    this.observer.broadcast(plugin);
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
    this.observer.changed();
  }

  private sort(): void {
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Принять новый инстанс плагина из источника гейта (главного менеджера).
   *
   * Живой прогон вскрыл дыру: `reload` перечитывает плагин в главном
   * менеджере, а уже спавненная сессия веба держала **старый** инстанс — и его
   * хуки, и его тулы (правка `handler` в файле плагина не доезжала минуя рестарт).
   */
  adopt(plugin: AgentPlugin): void {
    const existing = this.plugins.find((p) => p.name === plugin.name);
    if (existing) {
      this.plugins[this.plugins.indexOf(existing)] = plugin;
      this.observer.toolsChanged();
      return;
    }
    this.plugins.push(plugin);
    this.touch(plugin);
  }

  /**
   * Снять плагина с регистрации (вызывающий сам решает про `onUnload`).
   * Возвращает `false`, если плагина не было.
   */
  unregister(name: string): boolean {
    const index = this.plugins.findIndex((p) => p.name === name);
    if (index < 0) return false;
    this.plugins.splice(index, 1);
    this.loadedAt.delete(name);
    this.observer.changed();
    this.observer.broadcastRemoval(name);
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

  /** Заметить непрогрузившийся плагин (сейчас он просто исчезал из списков). */
  noteFailure(entry: string, path: string, message: string): void {
    this.failures.push({ entry, path, message: firstLine(message), at: Date.now() });
    this.observer.recordsChanged();
  }

  /** Отказы загрузки (`entry`, путь, причина) для UI и `mma plugins list`. */
  getFailures(): PluginLoadFailure[] {
    return this.failures.map((f) => ({ ...f }));
  }

  /** Сбросить накопленные отказы — перезагрузка пересобирает список заново. */
  clearFailures(): void {
    this.failures = [];
    this.observer.recordsChanged();
  }

  /** Все зарегистрированные плагины (внутренний порядок — по приоритету). */
  all(): AgentPlugin[] {
    return this.plugins;
  }

  /**
   * Активные плагины в порядке приоритета — единственная точка фильтрации.
   * От неё зависят все диспатчеры и `getAllPlugins`, поэтому выключение одного
   * плагина не требует правок в 15 хуках.
   */
  active(disabled: ReadonlySet<string>): AgentPlugin[] {
    if (disabled.size === 0) return [...this.plugins];
    return this.plugins.filter((p) => !disabled.has(p.name));
  }

  /** Ищет зарегистрированный плагин по имени; null, если нет. */
  find(name: string): AgentPlugin | null {
    return this.plugins.find((p) => p.name === name) ?? null;
  }

  isRegistered(name: string): boolean {
    return this.plugins.some((p) => p.name === name);
  }

  /** Имена системных плагинов: их нельзя выключить через deny-list. */
  systemNames(): Set<string> {
    return new Set(this.plugins.filter((p) => p.system).map((p) => p.name));
  }

  /** Момент регистрации плагина (для плоских записей). */
  loadedAtOf(name: string): number | undefined {
    return this.loadedAt.get(name);
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
