// Хуки реестра плагинов: публичные `runOn*` методы — тонкая обёртка над
// `PluginDispatcher`. Вынесены в базовый класс, чтобы `PluginManager` занимался
// состоянием реестра, а не пятнадцатью делегирующими сигнатурами.
import type { AgentPlugin, HostBridge, PluginHookContext, TurnSummary } from "../types";
import type { ToolCall, ToolResult } from "../../tools/types";
import type { AgentPhase, LLMResponse } from "../../core/types";
import { PluginDispatcher } from "./dispatch";
import type { PluginLog } from "./log";

/** База `PluginManager`: диспатчер хуков и его публичная поверхность. */
export abstract class PluginHooks {
  private readonly dispatcher: PluginDispatcher;

  constructor(log: PluginLog) {
    this.dispatcher = new PluginDispatcher(() => this.active(), log);
  }

  /** Текущий активный набор плагинов (реализует наследник). */
  protected abstract active(): AgentPlugin[];

  /** Регистрирует host-мост (ставит REPL один раз). */
  setHostBridge(bridge: HostBridge): void {
    this.dispatcher.setHostBridge(bridge);
  }

  runOnBuildPrompt(): (string | null)[] {
    return this.dispatcher.runOnBuildPrompt();
  }

  runOnBeforeTool(rawCtx: PluginHookContext, call: ToolCall): Promise<boolean> {
    return this.dispatcher.runOnBeforeTool(rawCtx, call);
  }

  runOnAfterTool(rawCtx: PluginHookContext, call: ToolCall, result: ToolResult): Promise<void> {
    return this.dispatcher.runOnAfterTool(rawCtx, call, result);
  }

  runOnError(rawCtx: PluginHookContext, error: Error): Promise<void> {
    return this.dispatcher.runOnError(rawCtx, error);
  }

  runOnSessionStart(rawCtx: PluginHookContext): void {
    this.dispatcher.runOnSessionStart(rawCtx);
  }

  runOnBeforeThink(rawCtx: PluginHookContext): void {
    this.dispatcher.runOnBeforeThink(rawCtx);
  }

  runOnAfterThink(rawCtx: PluginHookContext, response: LLMResponse | null): void {
    this.dispatcher.runOnAfterThink(rawCtx, response);
  }

  runOnSessionEnd(rawCtx: PluginHookContext): void {
    this.dispatcher.runOnSessionEnd(rawCtx);
  }

  runOnToolCall(rawCtx: PluginHookContext): void {
    this.dispatcher.runOnToolCall(rawCtx);
  }

  runOnPhase(rawCtx: PluginHookContext, phase: AgentPhase): void {
    this.dispatcher.runOnPhase(rawCtx, phase);
  }

  runOnToolStart(rawCtx: PluginHookContext, call: ToolCall): void {
    this.dispatcher.runOnToolStart(rawCtx, call);
  }

  runOnToolEnd(rawCtx: PluginHookContext, call: ToolCall, result: ToolResult, durationMs: number): void {
    this.dispatcher.runOnToolEnd(rawCtx, call, result, durationMs);
  }

  runOnText(rawCtx: PluginHookContext, chunk: string): string {
    return this.dispatcher.runOnText(rawCtx, chunk);
  }

  runOnMeta(rawCtx: PluginHookContext, chunk: string): string {
    return this.dispatcher.runOnMeta(rawCtx, chunk);
  }

  runOnTurnEnd(rawCtx: PluginHookContext, summary: TurnSummary): void {
    this.dispatcher.runOnTurnEnd(rawCtx, summary);
  }
}
