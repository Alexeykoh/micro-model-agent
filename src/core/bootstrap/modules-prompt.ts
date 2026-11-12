/**
 * Сборка промпт-блоков фазы 5 bootstrap.
 *
 * Вынесено из `modules-phase.ts` без изменения поведения: статичные блоки
 * (systemInfo + модули + AGENTS.md + plan-напоминание), стартовый dry-run
 * переполнения и динамические/ленивые блоки каждого хода.
 */
import { buildHiddenToolsBlock } from "../../tools/hidden-tools-block";
import { pluginCapabilitiesBlock } from "../../modules/plugins/capabilities-block";
import { estimateTokens } from "../../llm/token-counter";
import type { ExecutionModule } from "../../modules/execution/module";
import type { SessionModule } from "../../modules/session/index";
import type { ModuleHost } from "../module-host";
import type { PromptBlock } from "../types";
import { t } from "../../i18n/index";
import { assembleDynamicPromptBlocks } from "../prompt-assembler";
import { dryRunOverflow, overflowHint } from "../prompt-overflow";
import { filterBlocksForTags } from "../prompt-builder";
import { loadAgentsMdBlocks } from "./state";
import type { ModulesPhaseInput } from "./state";

/**
 * Статичные промпт-блоки: systemInfo + реестреые + AGENTS.md + plan-напоминание.
 * Заодно вешает onCompact и провайдер сводки плана (состояние — в замыканиях
 * менеджера контекста, порядок 1:1 с исходником).
 */
export function buildStaticPromptBlocks(
  input: ModulesPhaseInput,
  moduleHost: ModuleHost,
  execModule: ExecutionModule,
): PromptBlock[] {
  const { config, baseDir, dir, noAgentsMd, sessionManager, contextManager, systemInfoPrompt } =
    input;

  contextManager.onCompact = (summary) => {
    const meta = sessionManager.getActiveMeta();
    if (!meta || !config.session.autoSave) return;
    sessionManager.appendMessage({
      role: summary.role,
      content: summary.content,
      name: summary.name,
      timestamp: new Date().toISOString(),
    });
  };

  // Активный план (id, прогресс, текущий шаг) — в сводку компакции, чтобы 9B
  // модель не пересоздавала план с нуля сразу после неё (наблюдалось:
  // ses_msvuao0h — plan_e07pb2 (1/6) выкинут ради свежего plan_xzq9xe той же
  // итерацией, где старый план ещё был виден).
  contextManager.setPlanSummaryProvider(() => execModule.getPlanSummary());

  const agentsMdBlocks = loadAgentsMdBlocks(baseDir, dir, noAgentsMd === true);

  return [
    systemInfoPrompt,
    ...moduleHost.collectPromptBlocks(["indexer", "session", "skills"]),
    ...agentsMdBlocks,
    // Статичное напоминание о плане: всегда в наличии, чтобы модель проверяла
    // активный план до создания нового (даже на первой итерации, до появления
    // <system-summary>).
    {
      source: "core",
      label: "plan reminder",
      content:
        "[Plan Reminder] An active plan may exist for this session. Before creating a new plan, check with `plan show`. If a plan is active, continue it — do NOT create a new plan.",
      priority: "high",
      essential: false,
      estimatedTokens: 50,
    },
  ];
}

/**
 * Стартовый dry-run переполнения (баннер, A3): тот же набор блоков, что возьмёт
 * первая сборка Agent (статика + скиллы + карта + скрытые тулы), наружу —
 * невместившиеся instructions/project-map. Agent сожмёт их перед первым
 * LLM-вызовом; варнинг говорит ПОЛЬЗОВАТЕЛЮ почему и как вернуть полный текст.
 */
export function dryRunStartupOverflow(
  input: ModulesPhaseInput,
  promptBlocks: PromptBlock[],
): void {
  const { config, logger, dir, toolRegistry, activeToolTags, skillsModule, indexerModule } = input;
  const dynamicBlocks: PromptBlock[] = [];
  for (const block of skillsModule.getPromptBlocks()) dynamicBlocks.push(block);
  const mapBlock = indexerModule.getSystemPromptBlock();
  if (mapBlock) dynamicBlocks.push(mapBlock);
  const hiddenToolsBlock = buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
  if (hiddenToolsBlock) {
    dynamicBlocks.push({
      content: hiddenToolsBlock,
      priority: "low",
      essential: false,
      estimatedTokens: estimateTokens(hiddenToolsBlock),
    });
  }
  const systemBudget = Math.floor(config.contextWindow * config.contextBudget.systemPrompt);
  const dry = dryRunOverflow(filterBlocksForTags([...promptBlocks, ...dynamicBlocks], activeToolTags), systemBudget);
  if (dry.overflow.length === 0) return;
  const overflowTokens = dry.overflow.reduce((s, b) => s + b.estimatedTokens, 0);
  const needed = dry.includedTokens + overflowTokens;
  const hint = overflowHint(config, dir, needed);
  for (const b of dry.overflow) {
    // INV-17: называем владельца и блок (`indexer: project map`), а не только
    // класс по `kind`.
    const owner = b.source ? `${b.source}: ` : "";
    const name = b.label ?? (b.kind === "instructions" ? "AGENTS.md" : "project map");
    logger.warn(
      t("prompt.overflow.startup", {
        block: `${owner}${name}`,
        original: String(b.estimatedTokens),
        needed: String(needed),
        budget: String(systemBudget),
        hint,
      }),
    );
  }
}

/**
 * Динамические блоки (skills/сессия/карта/скрытые тулы) — собираются свежими
 * при каждом вызове. Мета сессии — здесь, а не при bootstrap: сессия создаётся
 * при bootstrap с messageCount 0, и статичный сбор всегда давал бы null.
 * Контент стабилен на сессию (без per-turn полей) ради prefix KV-кеша.
 */
export function collectDynamicPromptBlocks(
  input: ModulesPhaseInput,
  sessionModule: SessionModule,
): PromptBlock[] {
  const capabilitiesBlock = pluginCapabilitiesBlock({
    pluginManager: input.pluginManager,
    // Суженный набор (онбординг с allowlist'ом) не должен получать блок про
    // плагины: там `define_capability` модели всё равно недоступен.
    pluginsVisible: !input.toolCtx.toolAllowlist,
  });
  // B5: идентичность — из ЖИВОГО конфига (`toolCtx.config` — геттер поверх
  // configRef), а не из bootstrap-снимка `input.config`: reconfigure заменяет
  // объект конфига, замыкание на старом врало бы про модель до рестарта.
  const liveModel = input.toolCtx.config?.model ?? input.config.model;
  // Единый сборщик (INV-16): та же структура, что у раннера.
  return assembleDynamicPromptBlocks({
    model: liveModel,
    skillsModule: input.skillsModule,
    sessionModule,
    indexerModule: input.indexerModule,
    registry: input.toolRegistry,
    activeTags: input.activeToolTags,
    toolAllowlist: input.toolCtx.toolAllowlist,
    capabilitiesBlock: capabilitiesBlock ? { source: "plugins", ...capabilitiesBlock } : null,
  });
}

/** Ленивые блоки: фоновая стартовая проверка, мемоизированная первым вызовом. */
export function makeLazyPromptBlocks(
  startupCheckPromise: Promise<PromptBlock | null>,
): () => Promise<PromptBlock[]> {
  let startupCheckBlock: PromptBlock | null = null;
  return async (): Promise<PromptBlock[]> => {
    if (startupCheckBlock) return [startupCheckBlock];
    startupCheckBlock = (await startupCheckPromise) ?? null;
    return startupCheckBlock ? [startupCheckBlock] : [];
  };
}
