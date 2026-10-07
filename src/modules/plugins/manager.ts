// Менеджер плагинов: регистрация с дедупом по версии, вкл/выкл и диспатч хуков
// с изоляцией ошибок.
import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { semverGt } from "../updater/checker";
import { Logger } from "../../logger/app-logger";
import {
  buildRecord,
  firstLine,
  validatePluginMeta,
  type PluginLoadFailure,
  type PluginRecord,
} from "./records";

const logger = new Logger("warn", "plugins");

/**
 * Гоняет (возможно асинхронный) хук плагина с изоляцией ошибок. Синхронные
 * броски и асинхронные реджекты логгируются и глотаются — один битый плагин
 * не должен ронять агента и остальные плагины.
 */
function safeInvoke(plugin: AgentPlugin, hookName: string, fn: () => unknown): unknown {
  try {
    const out = fn();
    if (out instanceof Promise) {
      // Промис реджектится УЖЕ ПОСЛЕ выхода из этого try/catch — вешаем catch
      // сразу, иначе изоляцию ломает необработанный unhandledRejection.
      out.catch((e: unknown) => {
        logger.warn(`plugin "${plugin.name}" ${hookName} rejected`, { error: String(e) });
      });
      return undefined;
    }
    return out;
  } catch (e) {
    logger.warn(`plugin "${plugin.name}" ${hookName} threw`, { error: String(e) });
    return undefined;
  }
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

/** Менеджер плагинов: реестр, сортировка по приоритету, вкл/выкл, диспатч хуков. */
export class PluginManager {
  private plugins: AgentPlugin[] = [];
  private hostBridge: HostBridge | null = null;
  private disabled = new Set<string>();
  private loadedAt = new Map<string, number>();
  private failures: PluginLoadFailure[] = [];
  /** Кэш плоских записей; инвалидируется на любое изменение реестра. */
  private recordsCache: PluginRecord[] | null = null;

  /**
   * Регистрирует host-мост (ставит REPL один раз). Подмешивается в каждый
   * хук-контекст как `ctx.hostBridge`, если вызывающий не дал свой.
   */
  setHostBridge(bridge: HostBridge): void {
    this.hostBridge = bridge;
  }

  /** Подмешивает host-мост в хук-контекст (значение вызывающего побеждает). */
  private withHost<T>(ctx: T): T {
    if (!ctx || typeof ctx !== "object") return ctx;
    if (!this.hostBridge || (ctx as Record<string, unknown>).hostBridge !== undefined) {
      return ctx;
    }
    return { ...(ctx as object), hostBridge: this.hostBridge } as T;
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
    if (meta.errors.length > 0) {
      return { status: "invalid", errors: meta.errors };
    }
    if (source) plugin.source = source;
    const existing = this.plugins.find((p) => p.name === plugin.name);
    if (existing) {
      if (semverGt(plugin.version || "0.0.0", existing.version || "0.0.0")) {
        this.plugins = this.plugins.filter((p) => p.name !== plugin.name);
        this.plugins.push(plugin);
        this.loadedAt.set(plugin.name, Date.now());
        this.sort();
        this.recordsCache = null;
        return { status: "registered", warnings: meta.warnings };
      }
      return { status: "skipped_older", existing };
    }
    this.plugins.push(plugin);
    this.loadedAt.set(plugin.name, Date.now());
    this.sort();
    this.recordsCache = null;
    return { status: "registered", warnings: meta.warnings };
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

  private sort(): void {
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /**
   * Активные плагины в порядке приоритета — единственная точка фильтрации.
   * Все диспатчеры и `getAllPlugins` идут через неё, поэтому выключение
   * одного плагина не требует правок в 15 хуках.
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

  /**
   * Рассылка простого хука всем активным плагинам. Изоляция ошибок — `safeInvoke`,
   * поэтому девять однотипных циклов сводятся к одной строке на хук.
   */
  private fanout(rawCtx: any, hook: string, invoke: (plugin: AgentPlugin, ctx: any) => void): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.active()) {
      safeInvoke(plugin, hook, () => invoke(plugin, ctx));
    }
  }

  /** Гоняет хук сборки промпта по всем плагинам; собирает вклады. */
  runOnBuildPrompt(): (string | null)[] {
    return this.active().map(
      (p) => (safeInvoke(p, "onBuildPrompt", () => p.onBuildPrompt?.() ?? null) as string | null) ?? null,
    );
  }

  /**
   * Хук перед тулом. False (любой плагин против) — не выполнять.
   * Возвращает false при блокировке, true при разрешении.
   */
  async runOnBeforeTool(rawCtx: any, call: ToolCall): Promise<boolean> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.active()) {
      if (plugin.onBeforeTool) {
        try {
          const result = await plugin.onBeforeTool(ctx, call);
          // Контракт плагина разрешает блокировать `false` ИЛИ строкой-причиной
          // (экзекутор тулов понимает оба). Проигнорировать строку здесь —
          // молча не заблокировать, если путь когда-нибудь задействуют.
          if (result === false || typeof result === "string") return false;
        } catch (e) {
          logger.warn(`plugin "${plugin.name}" onBeforeTool failed`, { error: String(e) });
        }
      }
    }
    return true;
  }

  /** Хук после тула: отдаёт вызов и результат всем плагинам. */
  async runOnAfterTool(rawCtx: any, call: ToolCall, result: ToolResult): Promise<void> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.active()) {
      if (plugin.onAfterTool) {
        try {
          await plugin.onAfterTool(ctx, call, result);
        } catch (e) {
          logger.warn(`plugin "${plugin.name}" onAfterTool failed`, { error: String(e) });
        }
      }
    }
  }

  /** Хук ошибки агента: рассылает ошибку всем плагинам. */
  async runOnError(rawCtx: any, error: Error): Promise<void> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.active()) {
      if (plugin.onError) {
        try {
          await plugin.onError(ctx, error);
        } catch (e) {
          logger.warn(`plugin "${plugin.name}" onError failed`, { error: String(e) });
        }
      }
    }
  }

  /** Хук старта сессии. */
  runOnSessionStart(rawCtx: any): void {
    this.fanout(rawCtx, "onSessionStart", (p, ctx) => p.onSessionStart?.(ctx));
  }

  /** Хук перед обдумыванием (THINK). */
  runOnBeforeThink(rawCtx: any): void {
    this.fanout(rawCtx, "onBeforeThink", (p, ctx) => p.onBeforeThink?.(ctx));
  }

  /** Хук после ответа LLM. */
  runOnAfterThink(rawCtx: any, response: LLMResponse | null): void {
    this.fanout(rawCtx, "onAfterThink", (p, ctx) => p.onAfterThink?.(ctx, response));
  }

  /** Хук конца сессии. */
  runOnSessionEnd(rawCtx: any): void {
    this.fanout(rawCtx, "onSessionEnd", (p, ctx) => p.onSessionEnd?.(ctx));
  }

  /** Хук вызова тула (факт вызова, без результата). */
  runOnToolCall(rawCtx: any): void {
    this.fanout(rawCtx, "onToolCall", (p, ctx) => p.onToolCall?.(ctx));
  }

  /** Хук смены фазы агента. */
  runOnPhase(rawCtx: any, phase: AgentPhase): void {
    this.fanout(rawCtx, "onPhase", (p, ctx) => p.onPhase?.(ctx, phase));
  }

  /** Хук старта тул-вызова. */
  runOnToolStart(rawCtx: any, call: ToolCall): void {
    this.fanout(rawCtx, "onToolStart", (p, ctx) => p.onToolStart?.(ctx, call));
  }

  /** Хук конца тул-вызова (вызов, результат, длительность). */
  runOnToolEnd(rawCtx: any, call: ToolCall, result: ToolResult, durationMs: number): void {
    this.fanout(rawCtx, "onToolEnd", (p, ctx) => p.onToolEnd?.(ctx, call, result, durationMs));
  }

  /** Прогоняет текстовый чанк через трансформы плагинов; возвращает (возможно заменённый) чанк. */
  runOnText(rawCtx: any, chunk: string): string {
    let out = chunk;
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.active()) {
      if (plugin.onText) {
        const next = safeInvoke(plugin, "onText", () => plugin.onText!(ctx, out));
        if (typeof next === "string") out = next;
      }
    }
    return out;
  }

  /** Прогоняет мета-чанк через трансформы плагинов; возвращает (возможно заменённый) чанк. */
  runOnMeta(rawCtx: any, chunk: string): string {
    let out = chunk;
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.active()) {
      if (plugin.onMeta) {
        const next = safeInvoke(plugin, "onMeta", () => plugin.onMeta!(ctx, out));
        if (typeof next === "string") out = next;
      }
    }
    return out;
  }

  /** Рассылает сводку завершённого прогона всем плагинам (раз за Agent.run()). */
  runOnTurnEnd(rawCtx: any, summary: TurnSummary): void {
    this.fanout(rawCtx, "onTurnEnd", (p, ctx) => p.onTurnEnd?.(ctx, summary));
  }
}
