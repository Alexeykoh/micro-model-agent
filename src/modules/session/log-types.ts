// Типы записи session-журнала (вынесено из store.ts, правило 6: ≤300 строк).
import type { DiagnosticEvent, Source } from "../../output";
import type { EgressTurnSummary } from "../security/data-policy/types";

/** События онбординга (`meet`/`init`) — явный союз вместо `onboarding_${string}` (W11). */
export type OnboardingEvent =
  | "onboarding_meet_start"
  | "onboarding_meet_done"
  | "onboarding_init_start"
  | "onboarding_init_done";

/** Запись session-журнала (инструменты, usage, critic, пробы и т.д.). */
export interface SessionLogEntry {
  ts: string;
  type:
    | "tool_call"
    | "tool_result"
    | "assistant"
    | "reasoning"
    | "user"
    | "system"
    | "error"
    | "compaction"
    | "tool_defs"
    | "audit"
    | "plan"
    | "directive"
    | "context"
    | "llm_usage"
    | "session_start"
    | "baseline_typecheck"
    | "reasoning_control"
    | "context_probe"
    | "output"
    | "critic_check"
    | "critic_verdict"
    | "critic_escalation"
    | "gate_timing"
    | "retract"
    | DiagnosticEvent
    | "claim_retry"
    | "service_task"
    | "egress_turn"
    | "egress_redacted"
    | "subagent"
    | "command"
    | OnboardingEvent;
  /** Источник записи (INV-13); `llm_usage` пишет origin отдельно (W11). */
  source: Source;
  /**
   * Модуль-владелец записи (INV-13), без префикса `module:` — например `mcp`.
   */
  module?: string;
  subagent?: string;
  tool?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  args?: Record<string, unknown>;
  content?: string;
  diff?: string;
  /** Причина окончания генерации: `stop` | `length` | `tool_calls` (ses_mvpk4zjl). */
  finish?: string;
  /** Ref'ы сохранённых изображений — тулов или пользователя (для web replay). */
  images?: import("./image-store").ToolImageRef[];
  success?: boolean;
  duration?: number;
  /** Отзыв черновика (`retract`): кто отозвал и с каким вердиктом (причина — в `content`). */
  retractSource?: string;
  verdict?: string;
  gates?: { hallucination?: number; critic?: number; audit?: number };
  iteration?: number;
  contextTokens?: number;
  contextLimit?: number;
  toolCount?: number;
  toolNames?: string[];
  /** DLP-агрегат хода (`egress_turn`): классы/PII/назначение, без значений. */
  egress?: EgressTurnSummary;
  window?: number;
  systemBudget?: number;
  reserveBudget?: number;
  historyBudget?: number;
  systemTokens?: number;
  toolTokens?: number;
  /** Сырая оценка контекста (аддитивное диагностическое поле). */
  estimatedTokensRaw?: number;
  /** Отношение actual/estimated калибратора (аддитивное поле context). */
  calibrationRatio?: number;
  /** Состояние калибратора: cold|warming|trusted|stale. */
  calibrationState?: string;
  quality?: number;
  messageCount?: number;
  compactionCount?: number;
  iterationsSinceCompaction?: number;
  blocks?: Array<{
    label: string;
    priority: string;
    tokens: number;
    included: boolean;
  }>;
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  qualityBefore?: number;
  qualityAfter?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  removedTurns?: number;
  keptTurns?: number;
  summary?: string;
  /** Компакция: насколько упал объём (токены). Стадия — в `strategy`. */
  reducedBy?: number;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Origin измерения/решения (`usage`: api|estimate), НЕ provenance записи. */
  origin?: string;
  durationMs?: number;
  /** Стабильность префикса промпта (0..1), client-side монитор кеша. */
  cacheStable?: number;
  /** Причина расхождения префикса: system/tools/history/volatile/none/unknown. */
  cacheCause?: string;
  /** Прочитано из кеша (cache read) за вызов. */
  cachedTokens?: number;
  /** Записано в кеш (cache write) за вызов. */
  cacheWriteTokens?: number;
  /** Источник кеш-данных: api | derived. */
  cacheSource?: string;
  progress?: { totalBatches: number; novelTools: number; duplicateBatches: number };
  environment?: Record<string, unknown>;
  lspProbe?: {
    ok: Array<{ language: string; durationMs: number }>;
    failed: Array<{ language: string; error?: string; durationMs: number }>;
    noneApplicable: boolean;
  };
  plugins?: string[];
  skills?: number;
  passed?: boolean;
  message?: string;
  operation?: string;
  errorKind?: string;
  cause?: string;
  recoverable?: boolean;
  /** `audit`: пометка тест-прогона — скип/inconclusive/кэш (INV-15). */
  tests?: string;
  // Поля reasoning_control; `level` — заодно severity персистентных output-событий
  level?: string;
  strategy?: string;
  probePassed?: boolean;
  /** Класс claim-retry (success | artifact | output | repetition | …). */
  kind?: string;
  // Поля служебных событий (observability); subtaskId/expertTag/subtaskIds/
  // usageByTag больше не пишутся, но читаются в старых session.jsonl.
  title?: string;
  subtaskId?: string;
  expertTag?: string;
  status?: string;
  subtaskIds?: string[];
  cycle?: number;
  explanation?: string;
  decision?: string;
  usageByTag?: Record<
    string,
    { promptTokens: number; completionTokens: number; totalTokens: number; subtasks: number }
  >;
  // Поля service_task (Agent Service API v1): tenant/run-контекст (спека §10.3).
  tenantId?: string;
  principalId?: string;
  runId?: string;
  jobId?: string;
}
