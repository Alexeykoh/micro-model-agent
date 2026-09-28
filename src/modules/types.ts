/**
 * Контракты плагинов и хост-моста агента: модули, хуки жизненного цикла,
 * мост для управления прогоном из хоста (REPL/веб).
 */
import type { PromptBlock, AgentPhase, LLMResponse } from "../core/types";
import type { ToolDefinition, ToolCall, ToolResult } from "../tools/types";
import type { OutputEvent } from "../output/types";

export interface AgentModule {
  name: string;
  getSystemPromptBlock?(): PromptBlock | null;
  getToolDefinitions?(): ToolDefinition[];
  getPlugin?(): AgentPlugin;
}

export interface HostBridgeSubmitOptions {
  /** Data URL картинок к сообщению (`data:image/png;base64,...`). */
  images?: string[];
}

/**
 * Узкий API, который хост (REPL) отдаёт плагинам для управления агентом.
 * Регистрируется через `PluginManager.setHostBridge()` и подмешивается в
 * контекст каждого хука как `ctx.hostBridge`. Отсутствует в single-run
 * режиме и тестах без хоста.
 */
export interface HostBridge {
  /** True, пока агент обрабатывает ход. */
  isBusy(): boolean;
  /**
   * Отправить сообщение пользователя штатным входным путём хоста (как ввод
   * в REPL). Отклоняется, если агент занят. Резолвится по концу хода.
   */
  submit(text: string, opts?: HostBridgeSubmitOptions): Promise<unknown>;
  /** Прервать текущий прогон (no-op в простое). */
  interrupt(): void;
  /**
   * Подписка на шину вывода хоста (warn/error-логи, пробы провайдера).
   * Возвращает функцию отписки. Опционально, чтобы жили тестовые стабы.
   */
  subscribeOutput?(fn: (ev: OutputEvent) => void): () => void;
}

/** Итог завершённого прогона агента, передаётся в `AgentPlugin.onTurnEnd`. */
export interface TurnSummary {
  success: boolean;
  durationMs: number;
  textLength: number;
  toolCalls: number;
  interrupted?: boolean;
}

export interface AgentPlugin {
  name: string;
  priority?: number;
  isBuiltin?: boolean;
  /** Semver-версия плагина. Для дедупа (выигрывает старшая) и `mma plugins list`. */
  version?: string;
  /** Минимальная semver-версия MMA для запуска плагина. Несовместимые пропускаются загрузчиком. */
  minMmaVersion?: string;
  /** Откуда плагин: "builtin" | "global" | "project". Проставляет загрузчик/регистрация. */
  source?: "builtin" | "global" | "project";
  /** Добавить блок в системный промпт (выполняется один раз при построении). */
  onBuildPrompt?(): string | null;
  /**
   * Вернуть `false`, чтобы заблокировать вызов тула до исполнения, или строку —
   * заблокировать с явной причиной, видимой модели.
   */
  onBeforeTool?(ctx: any, call: ToolCall): boolean | string | Promise<boolean | string>;
  /** Выполняется после тула; может мутировать `result.output`. */
  onAfterTool?(ctx: any, call: ToolCall, result: ToolResult): void | Promise<void>;
  /** Перед каждым вызовом LLM. */
  onBeforeThink?(ctx: any): void;
  /** После ответа LLM; получает распарсенный ответ. */
  onAfterThink?(ctx: any, response: LLMResponse | null): void;
  /** Когда LLM вернула вызов тула. */
  onToolCall?(ctx: any): void;
  onError?(ctx: any, error: Error): void;
  onSessionStart?(ctx: any): void;
  onSessionEnd?(ctx: any): void;
  /** Жизненный цикл спиннера thinking: 'thinking' | 'done'. */
  onPhase?(ctx: any, phase: AgentPhase): void;
  /** Карточка тула открыта (до исполнения). */
  onToolStart?(ctx: any, call: ToolCall): void;
  /** Карточка тула закрыта (после исполнения, с длительностью). */
  onToolEnd?(ctx: any, call: ToolCall, result: ToolResult, durationMs: number): void;
  /** Трансформация/фильтр стримленного текста модели; строка — замена, undefined — пропустить. */
  onText?(ctx: any, chunk: string): string | undefined;
  /** Трансформация/фильтр стримленной меты (reasoning + вывод тулов); строка — замена, undefined — пропустить. */
  onMeta?(ctx: any, chunk: string): string | undefined;
  /** Вызывается один раз по завершении `run()` агента (финальный ответ, ошибка или прерывание). */
  onTurnEnd?(ctx: any, summary: TurnSummary): void;
}
