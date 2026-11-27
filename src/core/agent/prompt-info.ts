/**
 * Диагностика системного промпта: `/sysprompt`-инфо и лог состояния контекста.
 *
 * Вынесено из `prompt-phase.ts` (правило ≤300 строк). Сборка и резолв остаются
 * в фазе; здесь только чтение и запись снапшотов.
 */
import { estimateTokens } from "../../llm/token-counter";
import { resolveSystemBudget } from "../prompt-budget";
import { buildSystemPrompt } from "./prompt-phase";
import type { PromptPhaseHost } from "./prompt-phase";
import type { SessionLogger } from "../session-logger";

/** Текущий системный промпт с подсчётом токенов (для /sysprompt, диагностики). */
export interface SystemPromptInfo {
  text: string;
  /** Размер в той же линейке, что бюджет (`estimateTokens`, см. B2 выше). */
  tokenCount: number;
  /** Бюджет системного промпта (`contextWindow × contextBudget.systemPrompt`). */
  budget: number;
  excluded: string[];
  blocks: Array<{ label: string; priority: string; tokens: number; included: boolean }>;
}

/** Текущий системный промпт с подсчётом токенов (для /sysprompt, диагностики). */
export function getSystemPromptInfo(host: PromptPhaseHost): SystemPromptInfo {
  const { prompt, excluded, blocks } = buildSystemPrompt(host);
  const tokenCount = estimateTokens(prompt);
  const budget = resolveSystemBudget(host.deps.config);
  return { text: prompt, tokenCount, budget, excluded, blocks };
}

/**
 * Пишет состояние контекста в лог сессии (полный таймлайн роста/компакции);
 * `start`-снимок дополнительно несёт разбивку системных блоков.
 */
export function logContextStat(
  host: PromptPhaseHost,
  kind: "start" | "iteration",
  iteration: number,
  slog: SessionLogger,
  blocks?: Array<{ label: string; priority: string; tokens: number; included: boolean }>,
): void {
  const { deps } = host;
  const cm = deps.contextManager;
  if (typeof cm.getSnapshot !== "function") return;
  const snap = cm.getSnapshot();
  const diag = typeof cm.getEstimateDiagnostics === "function" ? cm.getEstimateDiagnostics() : undefined;
  const history = cm.getActiveHistory();
  const systemMsg = history.find((m) => m.role === "system");
  const systemTokens =
    kind === "start" && systemMsg && typeof systemMsg.content === "string"
      ? estimateTokens(systemMsg.content)
      : undefined;
  slog.logContext({
    kind,
    iteration,
    window: snap.window,
    systemBudget: snap.budget.systemPrompt,
    reserveBudget: snap.budget.responseReserve,
    historyBudget: snap.budget.history,
    systemTokens,
    startupTokens:
      kind === "start" ? (systemTokens ?? 0) + snap.toolTokens : undefined,
    toolTokens: snap.toolTokens,
    tokens: snap.tokens,
    estimatedTokensRaw: diag?.raw,
    contextTokens: diag?.calibrated,
    calibrationRatio: diag?.ratio,
    calibrationState: diag?.state,
    quality: snap.quality,
    messageCount: snap.messageCount,
    compactionCount: snap.compactionCount,
    iterationsSinceCompaction: snap.iterationsSinceCompaction,
    blocks,
  });
}
