/**
 * Состояние менеджера контекста. Вынесено из `manager.ts` (правило 6): класс
 * остаётся фасадом публичного API, швы (`manager-estimate`, `manager-history`,
 * `manager-compaction`) работают с этим состоянием как с явным аргументом.
 */
import type { ContextBudget as ConfigContextBudget } from "../../config/types";
import { DEFAULTS } from "../../config/defaults";
import { LARGE_WINDOW_THRESHOLD } from "../system-prompt";
import type { TokenCounter } from "../../llm/token-counter";
import { ContextCalibrator } from "../../core/api";
import { FactExtractor } from "./fact-extractor";
import type { ContextLedger } from "./ledger";
import { CompactionProgressTracker } from "./compaction-progress";
import { MessageBookkeeping } from "./message-bookkeeping";
import { PendingImageQueue } from "./pending-images";
import { CachedTokenEstimator } from "./token-cache";
import type { Message } from "./message";
import type { ContextBudget } from "./manager-types";

/** Резолвнутый тюнинг бюджета (дефолты конфига + явные значения). */
export interface ContextTuning {
  compactionThreshold: number;
  compactionMinLoad: number;
  policy: "legacy" | "v2";
  overflowCooldown: number;
  toolResultKeep: number;
  calibrationWarmup: number;
  ratioFloor: number;
  compactionSummary: "off" | "ledger" | "llm";
}

/** Всё изменяемое состояние одного `ContextManager`. */
export interface ContextState {
  contextWindow: number;
  messages: Message[];
  compactedBlock: string | null;
  iterationsSinceCompaction: number;
  compactionCount: number;
  peakTokens: number;
  budget: ContextBudget;
  compactionThreshold: number;
  /**
   * Минимальная загрузка истории (доля бюджета), нужная интервалу итераций для
   * срабатывания компакции. Интервал — защита от частоты, не триггер: слабо
   * загруженный контекст нельзя уплотнять лишь потому, что прошло N итераций
   * (было: компакция на ~40% бюджета стирала 33-44 полезных хода посреди задачи).
   */
  compactionMinLoad: number;
  /** Политика компакции v2/legacy. */
  policy: "legacy" | "v2";
  /** Мин. итераций между overflow-компакциями (v2). */
  overflowCooldown: number;
  /** Сколько последних tool-результатов не чистить (v2). */
  toolResultKeep: number;
  /** Режим сводки компакции: пинить `[Tool ledger]` или нет; `llm` — плюс LLM-сводка turns. */
  compactionSummaryMode: "off" | "ledger" | "llm";
  /**
   * Структурный леджер тулов: что уже прочитано/найдено/запущено. Копится через
   * компакции (пинится в каждой сводке), чтобы модель не переисследовала тот же
   * источник после сжатия истории (наблюдалось: 6× один и тот же web_fetch).
   */
  toolLedger: string[];
  toolLedgerKeys: Set<string>;
  /**
   * OO-3: durable леджер адресов (файловый), переживает любую компакцию. Когда
   * задан, блок компакции несёт только указатель, а не сырые заметки.
   */
  ledger: ContextLedger | null;
  /**
   * INV-15: детектор серии компакций без роста durable-леджера. Состояние и
   * эмит живут в helper'е (manager.ts на потолке ≤300-строк правила 6).
   */
  compactionProgress: CompactionProgressTracker;
  facts: FactExtractor;
  /** Последняя реальная инструкция юзера (мимо <system-summary>). */
  lastUserTask: string;
  /** Первая реальная инструкция сессии — переживает resetUserTurn(). */
  sessionMission: string;
  /** Последнее сообщение юзера, похожее на вставленную ошибку/лог (не задача). */
  lastUserFeedback: string;
  tokenCounter: TokenCounter | null;
  pendingImages: PendingImageQueue;
  /** Приёмник инъекций харнесса для журнала сессии (см. `setHarnessSink`). */
  harnessSink: ((text: string) => void) | null;
  /**
   * Стоящие директивы харнесса (`id → текст`). Директивы вставляются в контекст
   * как `<system-summary>`, который компакция вырезает; реестр позволяет вернуть
   * их после компакции (§1.5 аудита). Операции — `core/context/standing-directives`.
   */
  standingDirectives: Map<string, string>;
  toolTokens: number;
  /** seq, taint и доверие egress (вынесено в `message-bookkeeping`). */
  book: MessageBookkeeping;
  /** Калибратор оценки по реальному usage провайдера. */
  calibrator: ContextCalibrator;
  /** Опции калибратора — чтобы пересоздать при clear(). */
  calibrationOptions: { warmup?: number; ratioFloor?: number };
  /** Предыдущая сырая оценка и число сообщений — вход safety-clamp. */
  lastEstimateRaw: number;
  lastEstimateMessageCount: number;
  /** Последняя проверка overflow отказана safety-clamp (для лога). */
  lastJumpWasImplausible: boolean;
  /** Текущий reasoning-уровень (ставит цикл агента, входит в сводку компакции). */
  thinkingLevel: string | null;
  onCompact: ((summary: Message) => void) | null;
  /**
   * Опциональная короткая строка в сводку компакции, чтобы модель знала про
   * активный план с прогрессом. Прокидывается из bootstrap в execution-модуль —
   * без неё 9B-модель пересоздаёт план с нуля сразу после компакции (было:
   * ses_msvuao0h — plan_e07pb2 (1/6) выброшен ради свежего plan_xzq9xe в ту же
   * итерацию, когда старый план ещё был виден).
   */
  planSummaryProvider: (() => string | null) | null;
  /** Токенный кэш: сигнатура контента + пересчёт при мутации (вынесено). */
  tokenCache: CachedTokenEstimator;
}

/** Порог компакции на больших окнах (L3): рано резать нечего — room есть. */
export const LARGE_COMPACTION_THRESHOLD = 0.9;
/** Хранимых тул-результатов на больших окнах (L3): 6 душат длинные ходы. */
export const LARGE_TOOL_RESULT_KEEP = 20;

/** Резолвит тюнинг-параметры бюджета с безопасными дефолтами. */
export function resolveTuning(
  b: ConfigContextBudget | undefined,
  contextWindow?: number,
): ContextTuning {
  const merged = {
    ...DEFAULTS.contextBudget,
    ...(b ?? {}),
  } as Required<ConfigContextBudget>;
  // L3: дефолты настроены под тесноту 32K. На больших окнах те же дефолты
  // режут полезное (компакция на 75% выбрасывает контекст, 6 тул-результатов
  // при room для 20). Явные значения конфига побеждают всегда.
  const dflt = DEFAULTS.contextBudget;
  const isLarge = (contextWindow ?? 0) >= LARGE_WINDOW_THRESHOLD;
  return {
    compactionThreshold:
      merged.compactionThreshold !== dflt.compactionThreshold
        ? merged.compactionThreshold
        : isLarge
          ? LARGE_COMPACTION_THRESHOLD
          : merged.compactionThreshold,
    compactionMinLoad: merged.compactionMinLoad,
    policy: merged.policy,
    overflowCooldown: merged.overflowCooldown,
    toolResultKeep:
      merged.toolResultKeep !== dflt.toolResultKeep
        ? merged.toolResultKeep
        : isLarge
          ? LARGE_TOOL_RESULT_KEEP
          : merged.toolResultKeep,
    calibrationWarmup: merged.calibrationWarmup,
    ratioFloor: merged.ratioFloor,
    compactionSummary: merged.compactionSummary,
  };
}

/** Считает бюджет истории из долей окна или берёт legacy-дефолты. */
export function calculateBudget(
  window: number,
  contextBudget?: ConfigContextBudget,
): ContextBudget {
  if (contextBudget) {
    const systemPrompt = Math.floor(window * contextBudget.systemPrompt);
    const responseReserve = Math.floor(window * contextBudget.responseReserve);
    const history = Math.max(0, window - systemPrompt - responseReserve);
    return { systemPrompt, responseReserve, history };
  }
  // Фолбэк для обратной совместимости (тесты, сабагенты без явного бюджета)
  return {
    systemPrompt: Math.floor(window * 0.25),
    responseReserve: Math.floor(window * 0.12),
    history: Math.floor(window * 0.63),
  };
}

/** Создаёт состояние менеджера с тюнингом из конфига. */
export function createContextState(
  contextWindow: number,
  contextBudget?: ConfigContextBudget,
  tokenCounter?: TokenCounter | null,
): ContextState {
  const tuning = resolveTuning(contextBudget, contextWindow);
  const calibrationOptions = {
    warmup: tuning.calibrationWarmup,
    ratioFloor: tuning.ratioFloor,
  };
  return {
    contextWindow,
    messages: [],
    compactedBlock: null,
    iterationsSinceCompaction: 0,
    compactionCount: 0,
    peakTokens: 0,
    budget: calculateBudget(contextWindow, contextBudget),
    compactionThreshold: tuning.compactionThreshold,
    compactionMinLoad: tuning.compactionMinLoad,
    policy: tuning.policy,
    overflowCooldown: tuning.overflowCooldown,
    toolResultKeep: tuning.toolResultKeep,
    compactionSummaryMode: tuning.compactionSummary,
    toolLedger: [],
    toolLedgerKeys: new Set(),
    ledger: null,
    compactionProgress: new CompactionProgressTracker(),
    facts: new FactExtractor(),
    lastUserTask: "",
    sessionMission: "",
    lastUserFeedback: "",
    tokenCounter: tokenCounter ?? null,
    pendingImages: new PendingImageQueue(),
    harnessSink: null,
    standingDirectives: new Map<string, string>(),
    toolTokens: 0,
    book: new MessageBookkeeping(),
    calibrator: new ContextCalibrator(calibrationOptions),
    calibrationOptions,
    lastEstimateRaw: 0,
    lastEstimateMessageCount: 0,
    lastJumpWasImplausible: false,
    thinkingLevel: null,
    onCompact: null,
    planSummaryProvider: null,
    tokenCache: new CachedTokenEstimator(),
  };
}
