// Менеджер плагинов: регистрация с дедупом по версии и диспатч хуков с изоляцией ошибок.
import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { semverGt } from "../updater/checker";
import { Logger } from "../../logger/app-logger";

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

/** Итог регистрации: `registered` (встал/заменил), `skipped_older`, `duplicate`. */
export type RegisterResult =
  | { status: "registered" }
  | { status: "skipped_older"; existing: AgentPlugin }
  | { status: "duplicate" };

/** Плагин с источником загрузки (для показа в REPL/CLI). */
export interface PluginInfo {
  plugin: AgentPlugin;
  source?: "builtin" | "global" | "project";
}

/** Менеджер плагинов: реестр, сортировка по приоритету, диспатч хуков. */
export class PluginManager {
  private plugins: AgentPlugin[] = [];
  private hostBridge: HostBridge | null = null;

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
   */
  register(plugin: AgentPlugin, source?: "builtin" | "global" | "project"): RegisterResult {
    if (source) plugin.source = source;
    const existing = this.plugins.find((p) => p.name === plugin.name);
    if (existing) {
      if (semverGt(plugin.version || "0.0.0", existing.version || "0.0.0")) {
        this.plugins = this.plugins.filter((p) => p.name !== plugin.name);
        this.plugins.push(plugin);
        this.sort();
        return { status: "registered" };
      }
      return { status: "skipped_older", existing };
    }
    this.plugins.push(plugin);
    this.sort();
    return { status: "registered" };
  }

  private sort(): void {
    this.plugins.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  /** Все зарегистрированные плагины (копия, по приоритету). */
  getAllPlugins(): AgentPlugin[] {
    return [...this.plugins];
  }

  /** Детальный список (имя, версия, источник) для показа в REPL/CLI. */
  getPluginInfos(): PluginInfo[] {
    return [...this.plugins].map((plugin) => ({ plugin, source: plugin.source }));
  }

  /** Ищет зарегистрированный плагин по имени; null, если нет. */
  getPlugin(name: string): AgentPlugin | null {
    return this.plugins.find((p) => p.name === name) ?? null;
  }

  /** Гоняет хук сборки промпта по всем плагинам; собирает вклады. */
  runOnBuildPrompt(): (string | null)[] {
    return this.plugins.map(
      (p) => (safeInvoke(p, "onBuildPrompt", () => p.onBuildPrompt?.() ?? null) as string | null) ?? null,
    );
  }

  /**
   * Хук перед тулом. False (любой плагин против) — не выполнять.
   * Возвращает false при блокировке, true при разрешении.
   */
  async runOnBeforeTool(rawCtx: any, call: ToolCall): Promise<boolean> {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
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
    for (const plugin of this.plugins) {
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
    for (const plugin of this.plugins) {
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
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onSessionStart) {
        safeInvoke(plugin, "onSessionStart", () => plugin.onSessionStart!(ctx));
      }
    }
  }

  /** Хук перед обдумыванием (THINK). */
  runOnBeforeThink(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onBeforeThink) {
        safeInvoke(plugin, "onBeforeThink", () => plugin.onBeforeThink!(ctx));
      }
    }
  }

  /** Хук после ответа LLM. */
  runOnAfterThink(rawCtx: any, response: LLMResponse | null): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onAfterThink) {
        safeInvoke(plugin, "onAfterThink", () => plugin.onAfterThink!(ctx, response));
      }
    }
  }

  /** Хук конца сессии. */
  runOnSessionEnd(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onSessionEnd) {
        safeInvoke(plugin, "onSessionEnd", () => plugin.onSessionEnd!(ctx));
      }
    }
  }

  /** Хук вызова тула (факт вызова, без результата). */
  runOnToolCall(rawCtx: any): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolCall) {
        safeInvoke(plugin, "onToolCall", () => plugin.onToolCall!(ctx));
      }
    }
  }

  /** Хук смены фазы агента. */
  runOnPhase(rawCtx: any, phase: AgentPhase): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onPhase) {
        safeInvoke(plugin, "onPhase", () => plugin.onPhase!(ctx, phase));
      }
    }
  }

  /** Хук старта тул-вызова. */
  runOnToolStart(rawCtx: any, call: ToolCall): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolStart) {
        safeInvoke(plugin, "onToolStart", () => plugin.onToolStart!(ctx, call));
      }
    }
  }

  /** Хук конца тул-вызова (вызов, результат, длительность). */
  runOnToolEnd(rawCtx: any, call: ToolCall, result: ToolResult, durationMs: number): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onToolEnd) {
        safeInvoke(plugin, "onToolEnd", () => plugin.onToolEnd!(ctx, call, result, durationMs));
      }
    }
  }

  /** Прогоняет текстовый чанк через трансформы плагинов; возвращает (возможно заменённый) чанк. */
  runOnText(rawCtx: any, chunk: string): string {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onText) {
        const out = safeInvoke(plugin, "onText", () => plugin.onText!(ctx, chunk));
        if (typeof out === "string") chunk = out;
      }
    }
    return chunk;
  }

  /** Прогоняет мета-чанк через трансформы плагинов; возвращает (возможно заменённый) чанк. */
  runOnMeta(rawCtx: any, chunk: string): string {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onMeta) {
        const out = safeInvoke(plugin, "onMeta", () => plugin.onMeta!(ctx, chunk));
        if (typeof out === "string") chunk = out;
      }
    }
    return chunk;
  }

  /** Рассылает сводку завершённого прогона всем плагинам (раз за Agent.run()). */
  runOnTurnEnd(rawCtx: any, summary: TurnSummary): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.plugins) {
      if (plugin.onTurnEnd) {
        safeInvoke(plugin, "onTurnEnd", () => plugin.onTurnEnd!(ctx, summary));
      }
    }
  }
}
