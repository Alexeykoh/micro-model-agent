/**
 * Пролог итерации одиночного цикла (`TurnCoordinator`, INV-23): пересчёт
 * видимого набора тулов и их токен-бюджета, хук `onBeforeThink`, компакция,
 * рефреш системного промпта и нормализация истории, монитор префикса,
 * context-log, лог тулов/контекста. Возвращает значения, нужные телу итерации.
 *
 * Вынесено из `core/agent.ts`. Управляющего потока (continue/break) внутри нет.
 */
import type { AgentDeps } from "../agent";
import type { OnMeta } from "../types";
import type { ToolExecutor } from "../../tools/executor";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import type { CompactionService } from "./compaction";
import type { SystemPromptBuild } from "./prompt-phase";
import { filterDisabledTools } from "./tool-visibility";
import { repairToolCallPairing } from "./tool-pairing";
import { buildPromptSnapshot, diffPrompt } from "./prefix-monitor";
import { estimateTokens } from "../../llm/token-counter";

/** Мутабельный вид `Agent`, которым владеет пролог. */
export interface IterationPrologueHost {
  deps: AgentDeps;
  buildSystemPrompt(): SystemPromptBuild;
  logContextStat(
    kind: "start" | "iteration",
    iteration: number,
    slog: SessionLogger,
    blocks?: Array<{ label: string; priority: string; tokens: number; included: boolean }>,
  ): void;
  refreshSystemPrompt(): void;
}

/** Входные данные пролога одной итерации. */
export interface IterationPrologueInput {
  state: LoopState;
  slog: SessionLogger;
  input: string;
  onMeta?: OnMeta;
  compactionService: CompactionService;
}

/** Результат пролога: видимые тулы и нормализованная история. */
export interface IterationPrologueResult {
  allToolsForBudget: ReturnType<ToolExecutor["getToolDefinitions"]>;
  boundedToolNames: Set<string>;
  toolTokenEstimate: number;
  history: ReturnType<typeof repairToolCallPairing>;
}

/** Выполняет подготовительные шаги итерации до вызова LLM. */
export function runIterationPrologue(
  host: IterationPrologueHost,
  inp: IterationPrologueInput,
): IterationPrologueResult {
  const { deps } = host;
  const { state, slog, input, onMeta, compactionService } = inp;
  const { contextManager, pluginManager, logger, toolExecutor, config } = deps;

  // Перечитываем мутабельный набор тегов — вдруг вызывали enable_tools.
  // Отключённые за ход тулы исключаются из видимого набора.
  const allToolsForBudget = filterDisabledTools(
    toolExecutor.getToolDefinitions(deps.toolTags),
    state.disabledTools,
  );
  const boundedToolNames = new Set(
    allToolsForBudget.filter((t) => t.boundedOutput).map((t) => t.name),
  );
  const toolTokenEstimate = allToolsForBudget.reduce(
    (sum, t) => sum + estimateTokens(t.description + JSON.stringify(t.parameters)),
    0,
  );
  contextManager.setToolTokens(toolTokenEstimate);

  pluginManager.runOnBeforeThink({
    iteration: state.iteration,
    logger,
    lastUserMessage: input,
    contextManager,
    onMeta,
    sessionLog: {
      plan: (event: string, detail: string, iter?: number) => slog.logPlan(event, detail, iter),
    },
  });

  // Единая точка компакции: интервал → качество (с cooldown) → переполнение.
  compactionService.compactIfNeeded(state);

  host.refreshSystemPrompt();
  // Позиционная нормализация истории перед отправкой: вклинившийся user или
  // осиротевший tool ломает контракт OpenAI и даёт 400 у строгих провайдеров.
  const history = repairToolCallPairing(contextManager.getActiveHistory());

  // Монитор стабильности префикса: считаем до запроса, пишем в llm_usage после.
  const promptSnapshot = buildPromptSnapshot(history, allToolsForBudget);
  state.prefixDelta = diffPrompt(state.prevPrompt, promptSnapshot, estimateTokens);
  state.prevPrompt = promptSnapshot;

  // Opt-in git-style context log: snapshot отправляемого контекста.
  if (deps.contextLogger) {
    try {
      deps.contextLogger.record(history, allToolsForBudget, {
        iteration: state.iteration,
        ts: new Date().toISOString(),
        systemTokens: estimateTokens(promptSnapshot.system),
        toolTokens: estimateTokens(promptSnapshot.tools),
        historyTokens: estimateTokens(promptSnapshot.history),
        totalTokens: contextManager.getEstimatedTokens(),
        contextWindow: config.contextWindow,
      });
    } catch {
      // Логирование контекста не должно ронять агент.
    }
  }
  if (
    state.prefixDelta.cause === "system" ||
    state.prefixDelta.cause === "tools" ||
    state.prefixDelta.cause === "history" ||
    state.prefixDelta.cause === "volatile"
  ) {
    state.lastPrefixBreak = state.prefixDelta;
  }

  slog.logToolDefs(
    allToolsForBudget.length,
    allToolsForBudget.map((t) => t.name),
    state.iteration,
  );

  if (state.iteration === 1) {
    const { blocks } = host.buildSystemPrompt();
    host.logContextStat("start", state.iteration, slog, blocks);
  } else {
    host.logContextStat("iteration", state.iteration, slog);
  }

  return { allToolsForBudget, boundedToolNames, toolTokenEstimate, history };
}
