import { FORCED_COMPACTION_COOLDOWN } from "./constants";
import type { PrefixDelta, PromptSnapshot } from "./prefix-monitor";
import type { CacheUsage } from "../../llm/cache-usage";
import { createArtifactChurnState, type ArtifactChurnState } from "./artifact-progress";

/**
 * Состояние одного запуска агентного цикла (executeSingleAgentLoop).
 *
 * Заменяет ~24 разрозненных `let`-переменных одним структурированным объектом.
 * Группы полей соответствуют ответственностям цикла:
 * - счётчики и итоговый текст;
 * - компакция;
 * - халлюцинации;
 * - тулы (подпись, последовательные/общие неудачи, память);
 * - токены (API и fallback-оценки);
 * - аудит;
 * - терминальные условия;
 * - per-итерационные сигналы для reasoning policy.
 *
 * Модули цикла (compaction, tool-batch, gates) получают этот объект и
 * правят его поля — так между ними не плодятся длинные списки параметров.
 */
export interface LoopState {
  /** Текущий номер итерации (счётчик цикла). */
  iteration: number;
  /** Последний ПРИНЯТЫЙ текст ответа — итоговый ответ при выходе из цикла. */
  lastText: string;
  /**
   * Фактический последний вывод модели (включая повторные ответы). Сравнение
   * повторов идёт именно с ним, а не с последним *принятым* текстом — иначе
   * замороженный принятый ответ заставляет каждый повтор выглядеть как деградация.
   */
  lastModelText: string;

  /** Итерация последней принудительной компакции по качеству (для cooldown). */
  lastForcedCompactionIteration: number;

  /** Счётчик повторов при вердикте халлюцинации "retry". */
  hallucinationRetries: number;
  /** Счётчик перепроверок заявления об успехе (success-claim check). */
  claimCheckRetries: number;

  /** Подпись последнего пакета тулов (имя + JSON аргументов) для детекции повторов. */
  lastToolSignature: string;
  /** Подряд идущие итерации, где хотя бы один тул вернул неудачу. */
  consecutiveToolFailures: number;
  /** Подряд идущие успешные итерации с тулами — вход для reasoning policy. */
  consecutiveToolSuccesses: number;
  /** Счётчик повторных одинаковых тулов (exit-on-complete). */
  repeatedToolCount: number;
  /** Общий счётчик неудач по каждому тулу + последняя ошибка (не только подряд). */
  toolFailureCounts: Map<string, { count: number; error: string }>;
  /** Тулы, по которым правило в память уже записано (дедупликация). */
  memoryRuleRecorded: Set<string>;

  /**
   * Сколько раз за прогон мутировался один и тот же целевой объект
   * (файл для edit_file/write_file, нормализованная команда для bash).
   * Детектирует «перфекционизм-цикл» — многократный edit→build→read по
   * одному файлу, который подряд-детекция дубликатов не видит (аргументы
   * каждый раз новые).
   */
  toolTargetCounts: Map<string, number>;
  /** Ключи-цели, по которым nudge «закрывай задачу» уже отправлен (1 раз на цель). */
  cycleNudgedKeys: Set<string>;

  /** Прогресс тест/спек-артефактов: churn тестов без production-правок. */
  artifactChurn: ArtifactChurnState;
  /** В этом прогоне был ответ [SECURITY BLOCKED] (вход для script-workaround nudge). */
  sawSecurityBlock: boolean;
  /** Nudge против скрипта-обхода блокировки уже отправлен. */
  scriptWorkaroundNudged: boolean;

  /** Совокупные prompt-токены от API (заменяются per-итерацию). */
  apiPromptTokens: number;
  /** Совокупные completion-токены от API (заменяются per-итерацию). */
  apiCompletionTokens: number;
  /** Совокупные символы ответов — fallback-оценка токенов, когда API не отдаёт usage. */
  apiCompletionChars: number;
  /** Совокупная оценка prompt-токенов по итерациям — парный fallback к completion-символам. */
  estimatedPromptTokensTotal: number;
  /** Кеш-статистика последнего API-usage (заменяется per-итерацию). */
  cacheUsage?: CacheUsage;
  /** Накопительные кеш-токены за прогон. */
  cacheCachedTotal: number;
  cacheUncachedTotal: number;
  cacheWriteTotal: number;
  /** Источник кеш-данных за прогон. */
  cacheSource: "api" | "derived" | "none";
  /** Суммарная длительность LLM-вызовов (мс) — выставляется в AgentResult. */
  totalLlmDuration: number;

  /** Снимок промпта прошлой итерации для оценки стабильности префикса. */
  prevPrompt?: PromptSnapshot;
  /** Дельта префикса текущей итерации — пишется в llm_usage. */
  prefixDelta?: PrefixDelta;
  /** Последний РЕАЛЬНЫЙ разрыв префикса (system/tools/history/volatile). */
  lastPrefixBreak?: PrefixDelta;

  /** Счётчик отклонений финального аудита. */
  auditRetries: number;
  /** Последняя сводка неудачного аудита — для сообщения об ошибке. */
  lastAuditSummary: string;

  /** Critic LLM calls made this run. */
  criticCalls: number;
  /** Repair cycles consumed this run. */
  criticRepairCycles: number;
  /** Work mutations accumulated since the last critic call. */
  mutationsSinceCritic: number;
  /** Dedupe signatures of critic issues already surfaced. */
  seenCriticIssues: Set<string>;

  /** Счётчик пустых ответов. */
  emptyResponseRetries: number;
  /** Пустые ответы исчерпаны — итоговый результат success:false. */
  emptyResponseExhausted: boolean;
  /** Аудит провален после исчерпания повторов — итоговый результат success:false. */
  auditFailed: boolean;
  /**
   * Истинно, когда финальный ответ принят. Отменяет ошибку max_iters:
   * ответ на последней разрешённой итерации — это успех, а не "кончились итерации".
   */
  finalAnswerAccepted: boolean;
  /**
   * Подавление повтора после отклонения аудитом: повторный ответ на
   * уже-выполненную задачу естественно "повторяющийся" и не должен
   * сжигать бюджет халлюцинационных повторов.
   */
  suppressRepetitionRetry: boolean;
  /** Счётчик восстановимых ошибок LLM. */
  llmErrorRetries: number;

  // Per-итерационные сигналы для reasoning policy. Сбрасываются каждый ход.
  /** Предыдущая итерация завершилась повтором из-за халлюцинации. */
  iterHallucinationRetry: boolean;
  /** Предыдущая итерация завершилась отклонением аудита. */
  iterAuditRejection: boolean;
  /** Предыдущая итерация завершилась восстановимой ошибкой LLM. */
  iterRecoverableLlmError: boolean;
  /** Предыдущая итерация вызвала plan create/re-plan. */
  iterPlanCreated: boolean;
  /** Предыдущая итерация содержала повторный вызов тула с теми же аргументами. */
  iterRepetitive: boolean;
}

/** Фабрика начального состояния цикла. */
export function createLoopState(): LoopState {
  return {
    iteration: 0,
    lastText: "",
    lastModelText: "",
    lastForcedCompactionIteration: -FORCED_COMPACTION_COOLDOWN,
    hallucinationRetries: 0,
    claimCheckRetries: 0,
    lastToolSignature: "",
    consecutiveToolFailures: 0,
    consecutiveToolSuccesses: 0,
    repeatedToolCount: 0,
    toolFailureCounts: new Map(),
    memoryRuleRecorded: new Set(),
    toolTargetCounts: new Map(),
    cycleNudgedKeys: new Set(),
    artifactChurn: createArtifactChurnState(),
    sawSecurityBlock: false,
    scriptWorkaroundNudged: false,
    apiPromptTokens: 0,
    apiCompletionTokens: 0,
    apiCompletionChars: 0,
    estimatedPromptTokensTotal: 0,
    totalLlmDuration: 0,
    cacheCachedTotal: 0,
    cacheUncachedTotal: 0,
    cacheWriteTotal: 0,
    cacheSource: "none",
    auditRetries: 0,
    lastAuditSummary: "",
    criticCalls: 0,
    criticRepairCycles: 0,
    mutationsSinceCritic: 0,
    seenCriticIssues: new Set(),
    emptyResponseRetries: 0,
    emptyResponseExhausted: false,
    auditFailed: false,
    finalAnswerAccepted: false,
    suppressRepetitionRetry: false,
    llmErrorRetries: 0,
    iterHallucinationRetry: false,
    iterAuditRejection: false,
    iterRecoverableLlmError: false,
    iterPlanCreated: false,
    iterRepetitive: false,
  };
}

/**
 * Сброс per-итерационных сигналов reasoning policy. Вызывается в цикле
 * ПОСЛЕ оценки политики (политика читает сигналы предыдущей итерации),
 * перед тем как новые сигналы будут выставлены на текущем ходу.
 */
export function clearIterationSignals(state: LoopState): void {
  state.iterHallucinationRetry = false;
  state.iterAuditRejection = false;
  state.iterRecoverableLlmError = false;
  state.iterPlanCreated = false;
  state.iterRepetitive = false;
}