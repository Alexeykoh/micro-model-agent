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
import { PromptBuilder, filterBlocksForTags } from "../prompt-builder";
import { resolvePromptOverflow, overflowHint, HINT_BLOCK_TOKENS } from "../prompt-overflow";
import { buildServiceJobPrompt } from "../system-prompt";
import type { PromptBlock, PromptBlockKind, PromptProfile } from "../types";
import type { SessionLogger } from "../session-logger";
import type { AgentDeps } from "../agent";
import { t } from "../../i18n/index";

/** Мутабельный вид `Agent`, которым владеет фаза промпта. */
export interface PromptPhaseHost {
  deps: AgentDeps;
  /** Профиль промпта на текущий ход (`service-job` — без блоков харнесса). */
  promptProfile: PromptProfile;
  /** Замены переполнения по kind (сжатые instructions/project-map). */
  promptOverrides: Map<PromptBlockKind, PromptBlock>;
  /** Малый всегда-включённый hint-блок о сжатии. */
  overflowHintBlock: PromptBlock | null;
  /**
   * Снимок карты проекта на текущий ход. Карта меняется после каждой записи
   * (индексер пересобирается), а в системном промпте это рвёт KV-кеш префикса
   * на каждой итерации (наблюдалось: стабильность 51%). Внутри хода карта
   * имутабельна; свежую даёт тул `project_map` (аудит §8.7).
   */
  frozenMapBlock: PromptBlock | null;
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
  // S-04: service-job — своя короткая поверхность. Блоки харнесса (карта,
  // скиллы, AGENTS.md, скрытые тулы) в job-режиме не отправляются вовсе.
  if (host.promptProfile === "service-job") {
    const tools = deps.toolExecutor.getToolDefinitions(deps.toolTags).map((t) => t.name);
    const prompt = buildServiceJobPrompt(deps.config.model, tools);
    return {
      prompt,
      excluded: [],
      excludedBlocks: [],
      blocks: [
        {
          label: "service-job",
          priority: "high",
          tokens: deps.llmProvider.countTokens(prompt),
          included: true,
        },
      ],
    };
  }
  const systemBudget = Math.floor(
    deps.config.contextWindow * deps.config.contextBudget.systemPrompt,
  );
  const builder = new PromptBuilder(systemBudget);
  const applyOverrides = (blocks: PromptBlock[]): PromptBlock[] =>
    blocks.map((b) => (b.kind && host.promptOverrides.has(b.kind) ? host.promptOverrides.get(b.kind)! : b));
  builder.addBlocks(applyOverrides(filterBlocksForTags(deps.promptBlocks, deps.toolTags)));
  const dynamic = filterBlocksForTags(deps.getDynamicPromptBlocks?.() ?? [], deps.toolTags);
  const stableDynamic = freezeProjectMap(host, applyOverrides(dynamic));
  if (stableDynamic.length > 0) {
    builder.addBlocks(stableDynamic);
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
 * Держит карту проекта СНИМКОМ на ход: внутри хода системный промпт
 * имутабелен (KV-кеш не рвётся), между ходами снимок обновляется.
 */
function freezeProjectMap(host: PromptPhaseHost, blocks: PromptBlock[]): PromptBlock[] {
  const idx = blocks.findIndex((b) => b.kind === "project-map");
  if (idx < 0) return blocks;
  const current = blocks[idx]!;
  if (!host.frozenMapBlock) host.frozenMapBlock = current;
  const next = [...blocks];
  next[idx] = host.frozenMapBlock;
  return next;
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
export interface SystemPromptInfo {
  text: string;
  tokenCount: number;
  /** Бюджет системного промпта (contextWindow × contextBudget.systemPrompt). */
  budget: number;
  excluded: string[];
  blocks: SystemPromptBuild["blocks"];
}

export function getSystemPromptInfo(host: PromptPhaseHost): SystemPromptInfo {
  const { prompt, excluded, blocks } = buildSystemPrompt(host);
  const tokenCount = host.deps.llmProvider.countTokens(prompt);
  const budget = Math.floor(
    host.deps.config.contextWindow * host.deps.config.contextBudget.systemPrompt,
  );
  return { text: prompt, tokenCount, budget, excluded, blocks };
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
