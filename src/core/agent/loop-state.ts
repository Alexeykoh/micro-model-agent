/** Состояние одного запуска агентного цикла: счётчики, бюджеты, сигналы. */
import type { PrefixDelta, PromptSnapshot } from "./prefix-monitor";
import type { CacheUsage } from "../../llm/cache-usage";
import type { ArtifactChurnState } from "./artifact-progress";
import type { StopReason } from "../types";

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

  /**
   * Клоки компакции: по качеству, overflow, after-tool и ОБЩИЙ поперёк семейств (W4).
   */
  lastForcedCompactionIteration: number;
  lastOverflowCompactionIteration: number;
  lastPendingCompactionIteration: number;
  lastCompactionIteration: number;
  /** Лёгкий pre-check после тула выставил флаг — компакция на старте итерации. */
  pendingCompaction: boolean;
  /** Реактивная компакция (context-length error) уже применена в этом ходу. */
  reactiveCompactionUsed: boolean;

  /** Счётчик повторов при вердикте халлюцинации "retry". */
  hallucinationRetries: number;
  /** Счётчик перепроверок заявления об успехе (success-claim check). */
  claimCheckRetries: number;
  /** Счётчик перепроверок заявлений об артефактах (artifact-claim check). */
  artifactClaimRetries: number;
  /** Счётчик перепроверок неподтверждённого вывода (output-provenance check). */
  outputClaimRetries: number;
  /** Счётчик перепроверок веб-обоснования числовых утверждений (web-claim check). */
  webClaimRetries: number;
  /** Счётчик перепроверок «заявлено создание файла без write/edit» (file-creation check). */
  fileCreationRetries: number;

  /** Подпись последнего пакета тулов (имя + JSON аргументов) для детекции повторов. */
  lastToolSignature: string;
  /** Подряд идущие итерации, где хотя бы один тул вернул неудачу. */
  consecutiveToolFailures: number;
  /**
   * Итерация, на которой recovery-директива обновлялась последний раз.
   * Директива ставится один раз и обновляется не чаще, чем раз в
   * `RECOVERY_DIRECTIVE_REFRESH` итераций (иначе — спам на каждый батч).
   */
  lastRecoveryDirectiveIteration: number;
  /** Итерация последней записи правила в память об ошибках (троттлинг). */
  lastRecoveryMemoryRuleIteration: number;
  /**
   * Подряд идущие ПОЛНОСТЬЮ провальные пакеты тулов (каждый вызов — неудача
   * или tool-level блок; смешанные пакеты и успехи сбрасывают). Питает
   * honest-stop: директиву «остановись и ответь честно» и жёсткий стоп петли.
   */
  consecutiveFailedBatches: number;
  /** Honest-stop директива уже отправлена для текущего стрика (1 раз на стрик). */
  honestStopNudged: boolean;
  /**
   * Подряд идущие пакеты, где КАЖДЫЙ вызов дословно повторяет уже сделанный за
   * ход (канонический ключ). Питает duplicate-бюджет: директива «перестань
   * повторяться — ответь», затем жёсткий стоп. Широкая разведка новыми
   * файлами/паттернами прогрессирует — стрик не набирает.
   */
  consecutiveDuplicateBatches: number;
  /** Duplicate-директива уже отправлена для текущего стрика (1 раз). */
  duplicateNudged: boolean;
  /**
   * Подряд идущие пакеты, целиком состоящие из внешних веб-запросов
   * (web research). Питает одноразовую директиву «сведи к результату», когда
   * модель уходит в бесконечный веб-поиск без артефакта.
   */
  consecutiveResearchBatches: number;
  /** Директива «свести поиск к результату» уже отправлена (1 раз на стрик). */
  researchNudged: boolean;
  /**
   * Подряд идущие не-web батчи с результатом (после серии веб-поиска). Серия
   * research сбрасывается только после двух таких батчей (§1.4 аудита).
   */
  nonResearchBatchesWithResult: number;
  /** Канонические ключи всех вызовов за ход — вход duplicate-предиката. */
  seenToolCalls: Set<string>;
  /**
   * Причина принудительного завершения без тулов, или null. `max_iters` сюда
   * не попадает: он не приходит от батча, а выводится в цикле по дефолту.
   */
  finalizeReason: Exclude<StopReason, "max_iters"> | null;
  /** Машиночитаемая причина остановки для результата/чата (после финала). */
  stopReason: StopReason | null;
  /** Подряд идущие успешные итерации с тулами — вход для reasoning policy. */
  consecutiveToolSuccesses: number;
  /** Счётчик повторных одинаковых тулов (exit-on-complete). */
  repeatedToolCount: number;
  /** Общий счётчик неудач по каждому тулу + последняя ошибка и distinct
   *  первые строки ошибок (не только подряд). Distinct-заголовки нужны
   *  diagnoseRepeatedFailures: причина/решение по сигнатуре, а не boilerplate. */
  toolFailureCounts: Map<string, { count: number; error: string; samples: string[] }>;
  /** Тулы, по которым правило в память уже записано (дедупликация). */
  memoryRuleRecorded: Set<string>;
  /**
   * Тулы, отключённые на остаток хода: суммарно провалились больше
   * `MAX_TOOL_FAILURES_PER_TURN` раз (не транзиентные). Не попадают в видимый
   * модели набор тулов — иначе слабая модель бесконечно повторяет мёртвый тул.
   */
  disabledTools: Set<string>;
  /** Тулы, по которым директива «отключён» уже отправлена (1 раз на тул). */
  toolDisabledNudged: Set<string>;

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
  /** Совокупная стоимость вызовов по данным провайдера (USD). */
  apiCostUsd: number;
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

  /** Вызовы критика за прогон. */
  criticCalls: number;
  /** Израсходованные циклы починки за прогон. */
  criticRepairCycles: number;
  /** Рабочие мутации с последнего вызова критика. */
  mutationsSinceCritic: number;
  /**
   * Маркер seq на старте захода (executeSingleAgentLoop), из `ContextManager.beginTurn()`.
   * Маркер для gatherTurnToolEvents: критик видит только тул-события
   * текущего захода, а не всей сессии (иначе тулы прошлого вопроса —
   * напр. погода — ложно свидетельствуют против текущей задачи).
   * Монотонный seq переживает компакцию, поэтому сжатие истории посреди
   * хода больше не обнуляет улики текущего захода.
   */
  criticHistoryMark: number;
  /** Сигнатуры уже показанных проблем критика (дедупликация). */
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
export { createLoopState } from "./loop-state-init";

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

