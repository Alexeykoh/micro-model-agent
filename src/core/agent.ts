/**
 * Агент: одиночный цикл хода (INIT→…→OUTPUT), бюджеты, гейты. Петля и
 * lifecycle-хуки живут здесь, поверхность (доступы/промпт/провайдер) —
 * в `agent/agent-base.ts`.
 */
import type { ContentPart } from "../llm/provider";
import { finalizeWithoutTools as phaseFinalizeWithoutTools } from "./agent/turn-output";
import { runTurn, type TurnRunHost } from "./agent/turn-run";
import { executeAgentLoop } from "./agent/loop-run";
import { AgentBase } from "./agent/agent-base";
import { setContext, shutdownAgent } from "./agent/surface";
import {
  batchHost,
  iterationPrologueHost,
  llmPhaseHost,
  loopResultHost,
  loopSetupHost,
  turnOutputHost,
  type AgentHostView,
} from "./agent/hosts";
import type { PromptBlock } from "./types";
import type { AgentResult, OnMeta, OnPhase, ToolEvent } from "./types";
import type { SessionLogger } from "./session-logger";
import type { LoopState } from "./agent/loop-state";
import type { TokenTracker } from "./agent/token-tracker";

export type { AgentDeps, DiagnosticSink } from "./agent/deps";
export { toolOutputCharLimit, compactToolError } from "./agent/tool-output";

// `mutationTargetKey` переехал в `agent/loop-nudges.ts`; реэкспорт — для совместимости.
export { mutationTargetKey } from "./agent/loop-nudges";

/** Агент: владеет циклом, конфигом, стоимостью, гейтами. */
export class Agent extends AgentBase {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: пишется через TurnRunHost
  private systemPromptAdded = false;
  private shutdownRequested = false;
  private abortController: AbortController | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: читается/пишется через PromptPhaseHost
  private frozenMapBlock: PromptBlock | null = null;
  /** Гард одноразового асинхронного резолва переполнения в run(). */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: пишется через TurnRunHost
  private overflowResolved = false;
  /** Пауза хода на границе итераций (INV-P1, спека webui-pause-resume). */
  private pauseRequested = false;
  /** Резолвер ждущего гейта; один waiter на ход (агент не reentrant). */
  private pauseResolve: (() => void) | null = null;
  private pauseWait: Promise<void> | null = null;

  /** Общий вид хоста фаз (INV-23). */
  private hostView(): AgentHostView {
    return {
      deps: this.deps,
      costTracker: this.costTracker,
      contextRenderer: this.contextRenderer,
      policyState: this.policyState,
      reasoningState: this.reasoningState,
      probePassed: this.probePassed,
      isShutdownRequested: () => this.shutdownRequested,
      getAbortSignal: () => this.abortController?.signal,
      setScope: () => this.setScope(),
      callerProvenance: () => this.callerProvenance(),
      buildSystemPrompt: () => this.buildSystemPrompt(),
      logContextStat: (kind, iteration, slog, blocks) =>
        this.logContextStat(kind, iteration, slog, blocks),
      refreshSystemPrompt: () => this.refreshSystemPrompt(),
    };
  }

  /**
   * Аварийное завершение без тулов (реализация — `agent/turn-output.ts`):
   * один вызов модели без инструментов; гейты пропускаются.
   */
  private async finalizeWithoutTools(
    state: LoopState,
    tokenTracker: TokenTracker,
    onChunk?: (chunk: string) => void,
    slog?: SessionLogger,
  ): Promise<string> {
    return phaseFinalizeWithoutTools(turnOutputHost(this.hostView()), state, tokenTracker, onChunk, slog);
  }

  /**
   * Пауза хода на границе итераций: текущая итерация (LLM-стрим и батч
   * тулов) доходит до конца целиком, следующий вызов модели не начнётся до
   * resume(). Не durable — рестарт процесса теряет паузу (спека
   * docs/specs/2026-11-06-webui-pause-resume-design.md §1).
   */
  pause(): void {
    if (this.shutdownRequested) return;
    this.pauseRequested = true;
  }

  /** Снимает паузу и будит ждущий гейт; идемпотентна. */
  resume(): void {
    this.pauseRequested = false;
    const resolve = this.pauseResolve;
    this.pauseResolve = null;
    this.pauseWait = null;
    if (resolve) resolve();
  }

  /** Приостановлен ли ход сейчас (проект `pausedIds` в SSE `state`). */
  isPaused(): boolean {
    return this.pauseRequested;
  }

  /**
   * Гейт границы итераций: no-op без паузы; иначе один shared waiter —
   * повторный вызов во время паузы не плодит обещания.
   */
  private waitWhilePaused(): Promise<void> {
    if (!this.pauseRequested) return Promise.resolve();
    if (this.pauseWait) return this.pauseWait;
    this.pauseWait = new Promise<void>((resolve) => {
      this.pauseResolve = resolve;
    });
    return this.pauseWait;
  }

  /**
   * Прогоняет ход агента (одиночный цикл) с автонеймингом сессии.
   * @param input сообщение пользователя; @param onChunk/onMeta/onTool/onPhase/onReasoning колбэки вывода;
   * @returns итог прогона.
   */
  async run(
    input: string,
    onChunk?: (chunk: string) => void,
    onMeta?: OnMeta,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: OnPhase,
    onReasoning?: (reasoning: string) => void,
  ): Promise<AgentResult> {
    return runTurn(this as unknown as TurnRunHost, input, onChunk, onMeta, onTool, onPhase, onReasoning);
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: вызывается через TurnRunHost
  private async executeSingleAgentLoop(
    input: string,
    slog: SessionLogger,
    onChunk?: (chunk: string) => void,
    onMeta?: OnMeta,
    onTool?: (ev: ToolEvent) => void,
    onPhase?: OnPhase,
    onReasoning?: (reasoning: string) => void,
  ): Promise<AgentResult> {
    this.abortController = new AbortController();
    const view = this.hostView();
    return executeAgentLoop(
      {
        deps: this.deps,
        setIteration: (n) => {
          this._currentIteration = n;
        },
        isShutdownRequested: () => this.shutdownRequested,
        waitWhilePaused: () => this.waitWhilePaused(),
        loopSetupHost: () => loopSetupHost(view),
        iterationPrologueHost: () => iterationPrologueHost(view),
        llmPhaseHost: () => llmPhaseHost(view),
        batchHost: () => batchHost(view),
        loopResultHost: () => loopResultHost(view),
        finalizeWithoutTools: (state, tt, onChunk, slog) =>
          this.finalizeWithoutTools(state, tt, onChunk, slog),
      },
      input,
      slog,
      onChunk,
      onMeta,
      onTool,
      onPhase,
      onReasoning,
    );
  }

  /** Сбрасывает контекст (следующий прогон пересоберёт системный промпт). */
  clearContext(): void {
    this.deps.contextManager.clear();
    this.systemPromptAdded = false;
  }

  /**
   * Заменяет контекст историей (resume): системный промпт + сообщения без дубля system.
   * @param messages сообщения для восстановления.
   */
  setContext(
    messages: Array<{ role: string; content: string | ContentPart[]; name?: string }>,
  ): void {
    setContext(
      {
        deps: this.deps,
        buildSystemPrompt: () => this.buildSystemPrompt(),
        markSystemPromptAdded: () => {
          this.systemPromptAdded = true;
        },
      },
      messages,
    );
  }

  /**
   * Останавливает прогон: abort, kill фоновых процессов, onSessionEnd.
   * Лог сессии НЕ закрываем — сессия ещё активна (закрытие только на
   * реальном конце: exit, удаление сессии).
   * @param sessionId когда задан — убиваются только процессы этой сессии
   * (параллельные раннеры не трогают чужие фоновые процессы; без него —
   * все, как раньше).
   */
  shutdown(sessionId?: string): void {
    const { pluginManager, logger, sessionManager, contextManager, moduleHost } = this.deps;
    shutdownAgent(
      {
        pluginManager,
        logger,
        sessionManager,
        contextManager,
        moduleHost,
        requestShutdown: () => {
          this.shutdownRequested = true;
          this.abortController?.abort();
          // INV-P3: стоп не может зависнуть на паузе — будим гейт, цикл
          // выйдет по isShutdownRequested().
          this.resume();
        },
      },
      sessionId,
    );
  }
}
