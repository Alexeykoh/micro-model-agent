/**
 * Фаза системного промпта агента (`TurnCoordinator`, INV-23): сборка промпта из
 * статических/динамических/плагинных блоков с override-ами переполнения, лог
 * состояния контекста, `/sysprompt`-инфо, одноразовый резолв переполнения и
 * обновление системного сообщения в контексте.
 *
 * Вынесено из `core/agent.ts`; функции работают над `PromptPhaseHost` — узким
 * видом `Agent`.
 */
import { join } from "path";
import { projectMmaDir } from "../../config/paths";
import { PromptBuilder } from "../prompt-builder";
import { resolvePromptOverflow, overflowHint, HINT_BLOCK_TOKENS } from "../prompt-overflow";
import type { PromptBlock, PromptBlockKind } from "../types";
import type { SessionLogger } from "../session-logger";
import type { AgentDeps } from "../agent";
import { t } from "../../i18n/index";

/** Мутабельный вид `Agent`, которым владеет фаза промпта. */
export interface PromptPhaseHost {
  deps: AgentDeps;
  /** Замены переполнения по kind (сжатые instructions/project-map). */
  promptOverrides: Map<PromptBlockKind, PromptBlock>;
  /** Малый всегда-включённый hint-блок о сжатии. */
  overflowHintBlock: PromptBlock | null;
}

export interface SystemPromptBuild {
  prompt: string;
  excluded: string[];
  excludedBlocks: PromptBlock[];
  blocks: Array<{ label: string; priority: string; tokens: number; included: boolean }>;
}

/** Собирает системный промпт из блоков с учётом override-ов переполнения. */
export function buildSystemPrompt(host: PromptPhaseHost): SystemPromptBuild {
  const { deps } = host;
  const systemBudget = Math.floor(
    deps.config.contextWindow * deps.config.contextBudget.systemPrompt,
  );
  const builder = new PromptBuilder(systemBudget);
  const applyOverrides = (blocks: PromptBlock[]): PromptBlock[] =>
    blocks.map((b) => (b.kind && host.promptOverrides.has(b.kind) ? host.promptOverrides.get(b.kind)! : b));
  builder.addBlocks(applyOverrides(deps.promptBlocks));
  const dynamic = deps.getDynamicPromptBlocks?.() ?? [];
  if (dynamic.length > 0) {
    builder.addBlocks(applyOverrides(dynamic));
  }
  const pluginBlocks: PromptBlock[] = (deps.pluginManager.runOnBuildPrompt?.() ?? []).flatMap(
    (content): PromptBlock[] =>
      content && content.trim() !== ""
        ? [
            {
              source: "plugin",
              label: "capabilities",
              content,
              priority: "low" as const,
              essential: false,
              estimatedTokens: deps.llmProvider.countTokens(content),
            },
          ]
        : [],
  );
  if (pluginBlocks.length > 0) {
    builder.addBlocks(pluginBlocks);
  }
  if (host.overflowHintBlock) {
    builder.addBlock(host.overflowHintBlock);
  }
  const result = builder.build();
  return {
    prompt: result.prompt,
    excluded: result.excluded,
    excludedBlocks: result.excludedBlocks,
    blocks: result.blocks,
  };
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
  slog.logContext({
    kind,
    iteration,
    window: snap.window,
    systemBudget: snap.budget.systemPrompt,
    reserveBudget: snap.budget.responseReserve,
    historyBudget: snap.budget.history,
    systemTokens:
      kind === "start" && systemMsg && typeof systemMsg.content === "string"
        ? deps.llmProvider.countTokens(systemMsg.content)
        : undefined,
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

/** Текущий системный промпт с подсчётом токенов (для /sysprompt, диагностики). */
export function getSystemPromptInfo(host: PromptPhaseHost): {
  text: string;
  tokenCount: number;
  excluded: string[];
} {
  const { prompt, excluded } = buildSystemPrompt(host);
  const tokenCount = host.deps.llmProvider.countTokens(prompt);
  return { text: prompt, tokenCount, excluded };
}

/**
 * Одноразовая (первый прогон) обработка instructions/project-map сверх бюджета:
 * LLM суммаризирует в остаток (диск-кэш) или усекает; малый hint-блок говорит
 * модели, что случилось и как читать полный источник.
 */
export async function resolvePromptOverflowOnce(host: PromptPhaseHost): Promise<void> {
  const { deps } = host;
  const cfg = deps.config;
  const dry = buildSystemPrompt(host);
  const overflow = dry.excludedBlocks.filter((b) => Boolean(b.kind));
  if (overflow.length === 0) return;

  const systemBudget = Math.floor(cfg.contextWindow * cfg.contextBudget.systemPrompt);
  const res = await resolvePromptOverflow({
    overflow,
    includedTokens: dry.blocks.filter((b) => b.included).reduce((s, b) => s + b.tokens, 0),
    systemBudget,
    provider: cfg.instructions?.summarize === false ? null : deps.llmProvider,
    cacheDir: join(projectMmaDir(deps.baseDir), "cache", "prompt-summaries"),
    logger: deps.logger,
    sessionId: deps.sessionManager?.getActiveMeta()?.id,
  });
  for (const r of res.replacements) {
    if (r.kind) host.promptOverrides.set(r.kind, r);
  }
  host.overflowHintBlock = res.hintBlock;

  const needed =
    dry.blocks.filter((b) => b.included).reduce((s, b) => s + b.tokens, 0) +
    overflow.reduce((s, b) => s + b.estimatedTokens, 0) +
    HINT_BLOCK_TOKENS;
  const hint = overflowHint(cfg, deps.configDir, needed);
  for (const w of res.warnings) {
    deps.logger.warn(
      t("prompt.overflow.exceeded", {
        label: w.label,
        original: String(w.originalTokens),
        needed: String(needed),
        budget: String(systemBudget),
        mode: w.mode === "summary" ? "summarized" : "truncated",
        resolved: String(w.resolvedTokens),
        hint,
      }),
    );
  }
}

/** Обновляет системное сообщение в контексте, если промпт изменился. */
export function refreshSystemPrompt(host: PromptPhaseHost): void {
  const { prompt } = buildSystemPrompt(host);
  const current = host.deps.contextManager.getActiveHistory().find((m) => m.role === "system");
  if (!current || current.content !== prompt) {
    host.deps.contextManager.updateSystemPrompt?.(prompt);
  }
}
