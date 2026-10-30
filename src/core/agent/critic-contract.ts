// Контракт вентиля критика: зависимости, действие и опции. Вынесено из
// `critic-gate.ts` (правило ≤300); реэкспортируется оттуда для совместимости.
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../core/context/manager";
import type { CriticVerdict, EvidencePack } from "../../modules/critic/types";
import type { SessionLogger } from "../session-logger";
import type { OnMeta } from "../types";
import type { LoopState } from "./loop-state";

/** Зависимости вентиля критика: состояние, логгеры, события тулов хода. */
export interface CriticGateDeps {
  state: LoopState;
  iteration: number;
  logger: Logger;
  contextManager: ContextManager;
  slog: SessionLogger;
  task: string;
  planSummary?: string;
  toolEvents: Array<{
    tool: string;
    args?: Record<string, unknown>;
    ok?: boolean;
    output?: string;
  }>;
  /** True, если проверка идёт прямо перед принятием финального ответа. */
  beforeFinish: boolean;
  /**
   * Финальный текст ответа (для ходов без work-мутаций — чат-доставка).
   * Обрезается и редактируется в buildEvidencePack, не раньше.
   */
  answerText?: string;
  /**
   * Мета-канал для `retract`: repair/advice отклоняет уже отстримленный
   * черновик, потребители убирают его до переответа (иначе дубль в ленте).
   */
  onMeta?: OnMeta;
}

/** Действие вентиля: пропустить или переспросить модель. */
export type CriticAction = "pass" | "retry";

/** Опции вентиля: лимиты, верификатор и сборщик evidence-пакета. */
export interface CriticGateOptions {
  enabled: boolean;
  maxCalls: number;
  maxRepairCycles: number;
  /**
   * Потолок на всю проверку за один гейт (все проходы `verify`), мс.
   * Не задан — без дедлайна (поведение v1). См. `critic.timeoutMs` — это
   * ДРУГОЙ таймер: обёртка вокруг одного провайдерского запроса.
   */
  budgetMs?: number;
  verify: (pack: EvidencePack, signal?: AbortSignal) => Promise<CriticVerdict | null>;
  buildPack: (deps: CriticGateDeps) => EvidencePack;
  signal?: AbortSignal;
  /**
   * Последняя причина деградации, сообщённая клиентом критика (INV-C4).
   * Клиент знает причину («call_timeout», «обрезано по maxTokens», «не
   * разобрали JSON»), гейт — нет: он видит только `null`. Без этого хука
   * `critic_error` в сессии писал «no verdict returned» — причину отказа
   * было видно только в app-логе.
   */
  degradationReason?: () => string | undefined;
}
