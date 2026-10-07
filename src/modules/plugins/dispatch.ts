// Диспетчер хуков плагинов: рассылка + изоляция ошибок.
//
// Отделён от `PluginManager` (реестр), потому что менеджер и так держит
// дедуп/вкл-выкл/записи, а хуков — пятнадцать. Активные плагины и host-мост
// приходят провайдерами, поэтому менеджер может менять набор в рантайме, не
// пересоздавая диспетчер.
import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { Logger } from "../../logger/app-logger";

const logger = new Logger("warn", "plugins");

/** Откуда диспетчер берёт текущий активный набор. */
export type PluginsProvider = () => AgentPlugin[];

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

/** Рассылает хуки активных плагинов. Создаётся один раз на `PluginManager`. */
export class PluginDispatcher {
  constructor(
    private readonly active: PluginsProvider,
    private bridgeHost: HostBridge | null = null,
  ) {}

  /** REPL регистрирует мост один раз (см. `PluginManager.setHostBridge`). */
  setHostBridge(bridge: HostBridge | null): void {
    this.bridgeHost = bridge;
  }

  /** Подмешивает host-мост в хук-контекст (значение вызывающего побеждает). */
  private withHost<T>(ctx: T): T {
    if (!ctx || typeof ctx !== "object") return ctx;
    if (!this.bridgeHost || (ctx as Record<string, unknown>).hostBridge !== undefined) {
      return ctx;
    }
    return { ...(ctx as object), hostBridge: this.bridgeHost } as T;
  }

  /**
   * Рассылка простого хука. Изоляция — `safeInvoke`, поэтому девять однотипных
   * циклов сводятся к одной строке на хук.
   */
  private fanout(rawCtx: any, hook: string, invoke: (plugin: AgentPlugin, ctx: any) => void): void {
    const ctx = this.withHost(rawCtx);
    for (const plugin of this.active()) {
      safeInvoke(plugin, hook, () => invoke(plugin, ctx));
    }
  }

  /** Хук сборки промпта; собирает вклады. */
  runOnBuildPrompt(): (string | null)[] {
    return this.active().map(
      (p) =>
        (safeInvoke(p, "onBuildPrompt", () => p.onBuildPrompt?.() ?? null) as string | null) ?? null,
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

  runOnSessionStart(rawCtx: any): void {
    this.fanout(rawCtx, "onSessionStart", (p, ctx) => p.onSessionStart?.(ctx));
  }

  runOnBeforeThink(rawCtx: any): void {
    this.fanout(rawCtx, "onBeforeThink", (p, ctx) => p.onBeforeThink?.(ctx));
  }

  runOnAfterThink(rawCtx: any, response: LLMResponse | null): void {
    this.fanout(rawCtx, "onAfterThink", (p, ctx) => p.onAfterThink?.(ctx, response));
  }

  runOnSessionEnd(rawCtx: any): void {
    this.fanout(rawCtx, "onSessionEnd", (p, ctx) => p.onSessionEnd?.(ctx));
  }

  runOnToolCall(rawCtx: any): void {
    this.fanout(rawCtx, "onToolCall", (p, ctx) => p.onToolCall?.(ctx));
  }

  runOnPhase(rawCtx: any, phase: AgentPhase): void {
    this.fanout(rawCtx, "onPhase", (p, ctx) => p.onPhase?.(ctx, phase));
  }

  runOnToolStart(rawCtx: any, call: ToolCall): void {
    this.fanout(rawCtx, "onToolStart", (p, ctx) => p.onToolStart?.(ctx, call));
  }

  runOnToolEnd(rawCtx: any, call: ToolCall, result: ToolResult, durationMs: number): void {
    this.fanout(rawCtx, "onToolEnd", (p, ctx) => p.onToolEnd?.(ctx, call, result, durationMs));
  }

  /** Прогоняет текстовый чанк через трансформы; возвращает (возможно заменённый) чанк. */
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

  /** Прогоняет мета-чанк через трансформы; возвращает (возможно заменённый) чанк. */
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

  runOnTurnEnd(rawCtx: any, summary: TurnSummary): void {
    this.fanout(rawCtx, "onTurnEnd", (p, ctx) => p.onTurnEnd?.(ctx, summary));
  }
}