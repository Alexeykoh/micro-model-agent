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
import { createHash } from "crypto";
import { projectMmaDir } from "../../config/paths";
import { PromptBuilder, filterBlocksForTags, omittedBlocksNote } from "../prompt-builder";
import { resolvePromptOverflow, overflowHint, HINT_BLOCK_TOKENS } from "../prompt-overflow";
import { buildServiceJobPrompt } from "../system-prompt";
import { estimateTokens } from "../../llm/token-counter";
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
  /** Токены essential-блоков (см. `BuildResult.essentialTokens`, B3). */
  essentialTokens: number;
  /** Essential-блоки рвут бюджет — вызывающий обязан предупредить (B3). */
  essentialOverBudget: boolean;
  /**
   * Отпечаток входов резолва переполнения: бюджет + хеши kind-блоков
   * (instructions/project-map) ДО подмен. Стабилен между прогонами, пока ни
   * контент, ни бюджет не изменились — по нему `session-start` понимает, что
   * нужен повторный резолв (B16/B17). Для `service-job` — константа.
   */
  fingerprint: string;
}

/** Хеш контента kind-блока для отпечатка (B16: ловит правки любой длины). */
function kindHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Отпечаток входов резолва: бюджет плюс kind-блоки до override-подмен.
 * Подмены не входят намеренно — иначе каждый резолв менял бы отпечаток
 * и следующий прогон пересчитывал бы снова.
 */
function overflowFingerprint(systemBudget: number, blocks: PromptBlock[]): string {
  const kinds = blocks
    .filter((b) => b.kind)
    .map((b) => `${b.kind}:${kindHash(b.content)}`)
    .sort()
    .join("|");
  return `${systemBudget}|${kinds}`;
}

/** Собирает системный промпт из блоков с учётом override-ов переполнения. */
export function buildSystemPrompt(host: PromptPhaseHost): SystemPromptBuild {
  const { deps } = host;
  // B2: учёт бюджета — одной линейкой (`estimateTokens`) во всём промпт-тракте
  // (блоки, builder, dry-run, резолвер переполнения). Точный tiktoken-счётчик
  // провайдера (`llmProvider.countTokens`) для бюджета не используется:
  // смешанные линейки расходились до ±30% и вытесняли случайные блоки.
  // Выбор линейки под класс модели — задача L6.
  if (host.promptProfile === "service-job") {
    const tools = deps.toolExecutor.getToolDefinitions(deps.toolTags).map((t) => t.name);
    const prompt = buildServiceJobPrompt(deps.config.model, tools, deps.config.security);
    return {
      prompt,
      excluded: [],
      excludedBlocks: [],
      blocks: [
        {
          label: "service-job",
          priority: "high",
          tokens: estimateTokens(prompt),
          included: true,
        },
      ],
      essentialTokens: 0,
      essentialOverBudget: false,
      fingerprint: "service-job",
    };
  }
  const systemBudget = Math.floor(
    deps.config.contextWindow * deps.config.contextBudget.systemPrompt,
  );
  const builder = new PromptBuilder(systemBudget);
  const applyOverrides = (blocks: PromptBlock[]): PromptBlock[] =>
    blocks.map((b) => (b.kind && host.promptOverrides.has(b.kind) ? host.promptOverrides.get(b.kind)! : b));
  // B12: гейт по реально видимым тегам схемы (allowlist-aware), а не только
  // по активным — иначе блок рекламирует тул, которого нет в схеме LLM.
  const visibleTags = deps.toolExecutor.getVisibleTags(deps.toolTags);
  const staticRaws = deps.promptBlocks;
  const dynamicRaws = deps.getDynamicPromptBlocks?.() ?? [];
  // B16/B17: отпечаток считается по исходникам (до override-подмен и фильтров).
  const fingerprint = overflowFingerprint(systemBudget, [...staticRaws, ...dynamicRaws]);
  builder.addBlocks(applyOverrides(filterBlocksForTags(staticRaws, deps.toolTags, visibleTags)));
  const dynamic = filterBlocksForTags(dynamicRaws, deps.toolTags, visibleTags);
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
              estimatedTokens: estimateTokens(content),
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
  const note = omittedBlocksNote(result.excludedBlocks);
  if (!note) {
    return {
      prompt: result.prompt,
      excluded: result.excluded,
      excludedBlocks: result.excludedBlocks,
      blocks: result.blocks,
      essentialTokens: result.essentialTokens,
      essentialOverBudget: result.essentialOverBudget,
      fingerprint,
    };
  }
  builder.addBlock(note);
  const withNote = builder.build();
  return {
    prompt: withNote.prompt,
    excluded: withNote.excluded,
    excludedBlocks: withNote.excludedBlocks,
    blocks: withNote.blocks,
    essentialTokens: withNote.essentialTokens,
    essentialOverBudget: withNote.essentialOverBudget,
    fingerprint,
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
        ? estimateTokens(systemMsg.content)
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
  /** Размер в той же линейке, что бюджет (`estimateTokens`, см. B2 выше). */
  tokenCount: number;
  /** Бюджет системного промпта (contextWindow × contextBudget.systemPrompt). */
  budget: number;
  excluded: string[];
  blocks: SystemPromptBuild["blocks"];
}

export function getSystemPromptInfo(host: PromptPhaseHost): SystemPromptInfo {
  const { prompt, excluded, blocks } = buildSystemPrompt(host);
  const tokenCount = estimateTokens(prompt);
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
  // B3: essential-блоки рвут бюджет — единственная точка предупреждения для
  // всех поверхностей (main + раннеры + one-shot): bootstrap dry-run молчит
  // про essential специально, чтобы не дублировать баннер (kind-варнинги
  // там уже есть).
  if (dry.essentialOverBudget) {
    const systemBudget = Math.floor(cfg.contextWindow * cfg.contextBudget.systemPrompt);
    deps.logger.warn(
      t("prompt.overflow.essential_over_budget", {
        essential: String(dry.essentialTokens),
        budget: String(systemBudget),
        hint: overflowHint(cfg, deps.configDir, dry.essentialTokens),
      }),
    );
  }
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
    model: deps.config.model,
    contextWindow: cfg.contextWindow,
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
