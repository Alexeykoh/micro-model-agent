/**
 * Настройка модулей одиночного цикла хода (`TurnCoordinator`, INV-23):
 * сборка `LoopState` и сервисов (компакция, трекинг токенов, батч тулов, гейты
 * hallucination/audit/critic) с их зависимостями. Вынесено из
 * `core/agent.ts`; сам цикл остаётся в координаторе.
 */
import type { AgentDeps } from "../agent";
import type { SessionLogger } from "../session-logger";
import { createLoopState, type LoopState } from "./loop-state";
import { CompactionService } from "./compaction";
import { TokenTracker } from "./token-tracker";
import { ReasoningEffortResolver } from "./reasoning-resolver";
import { ToolBatchExecutor } from "./tool-batch";
import { HallucinationGate } from "./hallucination-gate";
import { AuditGate } from "./audit-gate";
import { CriticGate } from "./critic-gate";
import type { CostTracker } from "../../modules/pricing/index";
import { CriticClient, CRITIC_DEGRADED_PREFIX } from "../../modules/critic/client";
import { buildCriticProvider } from "../../modules/critic/provider";
import { CRITIC_READONLY_TOOLS } from "../../modules/critic/tools";
import { buildEvidencePack } from "../../modules/critic/evidence";

/** Мутабельный вид `Agent`, которым владеет настройка петли. */
export interface LoopSetupHost {
  deps: AgentDeps;
  costTracker: CostTracker;
  getAbortSignal(): AbortSignal | undefined;
  isShutdownRequested(): boolean;
  setScope(): void;
  callerProvenance(): { provider: string; model: string };
}

/** Готовые модули цикла (единый контейнер состояния + сервисы). */
export interface LoopModules {
  state: LoopState;
  compactionService: CompactionService;
  tokenTracker: TokenTracker;
  reasoningResolver: ReasoningEffortResolver;
  toolBatch: ToolBatchExecutor;
  hallucinationGate: HallucinationGate;
  auditGate: AuditGate;
  criticGate: CriticGate;
}

/** Собирает состояние и модули цикла из зависимостей агента. */
export function createLoopModules(host: LoopSetupHost, slog: SessionLogger): LoopModules {
  const { deps } = host;
  const { config, toolExecutor, pluginManager, contextManager, hallucinationDetector, logger } =
    deps;

  // Единый контейнер состояния цикла — заменяет ~24 разрозненных `let`.
  const state = createLoopState();
  // Маркер начала захода для критика: события тулов прошлых run'ов в
  // evidence-пакеты этого захода не входят. Fallback на длину — для моков.
  state.criticHistoryMark =
    typeof contextManager.beginTurn === "function"
      ? contextManager.beginTurn()
      : contextManager.getActiveHistory().length;

  const compactionService = new CompactionService({
    contextManager,
    logger,
    slog,
    hallucinationDetector,
  });
  const tokenTracker = new TokenTracker(host.costTracker, () => host.callerProvenance());
  const reasoningResolver = new ReasoningEffortResolver();
  const toolBatch = new ToolBatchExecutor({
    config,
    toolExecutor,
    pluginManager,
    contextManager,
    hallucinationDetector,
    compactionService,
    logger,
    memoryStore: deps.memoryStore,
    costTracker: host.costTracker,
    planSummary: deps.planSummary,
    getAbortSignal: () => host.getAbortSignal(),
    isShutdownRequested: () => host.isShutdownRequested(),
    setScope: () => host.setScope(),
  });
  const hallucinationGate = new HallucinationGate(hallucinationDetector);
  const auditGate = new AuditGate(deps.finalAudit);
  // Частичные/легаси конфиги могут не иметь домена `critic` — считаем выключенным.
  const criticConfig = {
    enabled: config.critic?.enabled ?? false,
    tools: config.critic?.tools ?? true,
    maxCalls: config.critic?.maxCalls ?? 4,
    maxRepairCycles: config.critic?.maxRepairCycles ?? 1,
    timeoutMs: config.critic?.timeoutMs ?? 60000,
    maxTokens: config.critic?.maxTokens ?? 2048,
  };
  const criticProvider = buildCriticProvider(config.critic, config, deps.llmProvider, {
    logger,
    getSessionId: () => deps.sessionManager?.getActiveMeta()?.id,
  });
  // Причина деградации живёт в клиенте («call_timeout», «обрезано по
  // maxTokens»); гейт видит только `null`. Снимаем её здесь, чтобы
  // `critic_error` в session.jsonl нёс РЕАЛЬНУЮ причину, а не «no verdict
  // returned» (INV-C4).
  let lastCriticDegradation: string | undefined;
  const criticClient = new CriticClient({
    provider: criticProvider,
    timeoutMs: criticConfig.timeoutMs,
    maxTokens: criticConfig.maxTokens,
    onDiagnostic: (m) => {
      logger.diagnostic("warn", m);
      if (m.startsWith(CRITIC_DEGRADED_PREFIX)) {
        lastCriticDegradation = m.slice(CRITIC_DEGRADED_PREFIX.length).trim();
      }
    },
  });
  const criticGate = new CriticGate({
    enabled: criticConfig.enabled,
    maxCalls: criticConfig.maxCalls,
    maxRepairCycles: criticConfig.maxRepairCycles,
    verify: deps.criticOverride?.verify ?? (async (pack, signal) => {
      // Сброс перед КАЖДЫМ вызовом: причина должна относиться к этой проверке.
      lastCriticDegradation = undefined;
      return criticClient.verify(pack, signal, {
        // Read-only цикл: проверки бегут последовательно здесь (гейт await'ится
        // между пакетами тулов), через общий executor с read-only allowlist.
        runCheck: criticConfig.tools && deps.toolCtx
          ? async (tool, args) => {
              const res = await toolExecutor.executeByName(tool, args, {
                ...deps.toolCtx!,
                toolAllowlist: [...CRITIC_READONLY_TOOLS],
              });
              return { ok: res.success, output: res.output ?? "" };
            }
          : undefined,
      });
    }),
    degradationReason: () => lastCriticDegradation,
    buildPack: (d) =>
      buildEvidencePack({
        task: d.task,
        planSummary: d.planSummary,
        toolEvents: d.toolEvents,
        baseDir: deps.baseDir,
        answerText: d.answerText,
      }),
    signal: host.getAbortSignal(),
  });

  return {
    state,
    compactionService,
    tokenTracker,
    reasoningResolver,
    toolBatch,
    hallucinationGate,
    auditGate,
    criticGate,
  };
}
