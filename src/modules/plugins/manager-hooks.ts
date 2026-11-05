// Хуки реестра плагинов: публичные `runOn*` методы — тонкая обёртка над
// `PluginDispatcher`. Вынесены в базовый класс, чтобы `PluginManager` занимался
// состоянием реестра, а не пятнадцатью делегирующими сигнатурами.
import type { AgentPlugin, HostBridge, TurnSummary } from "../types";
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
