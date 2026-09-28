/** Финальный аудит ответа: принят, отклонён или повторы исчерпаны. */
import { t } from "../../i18n/index";
import type { Logger } from "../../logger/app-logger";
import type { ContextManager } from "../../modules/context/manager";
import type { SessionLogger } from "../session-logger";
import { MAX_AUDIT_RETRIES } from "./constants";
import type { LoopState } from "./loop-state";

/** Результат финального аудита: покрытие плана и недостающие файлы. */
export interface FinalAuditResult {
  passed: boolean;
  done: number;
  total: number;
  pendingSteps: string[];
  missingFiles: string[];
  summary: string;
}

/** Вердикт аудита: принять ответ, переспросить или завершить неуспехом. */
export type AuditVerdict =
  /** Ответ принят — цикл завершается успехом. */
  | { action: "pass" }
  /** Аудит отклонил ответ — цикл делает continue (переспрос с контекстом). */
  | { action: "reject" }
  /** Повторы аудита исчерпаны — цикл завершается неуспехом. */
  | { action: "exhausted"; summary: string };

/** Зависимости вентиля аудита: состояние цикла, логгеры, контекст. */
export interface AuditGateDeps {
  state: LoopState;
  iteration: number;
  maxIterations: number;
  logger: Logger;
  contextManager: ContextManager;
  slog: SessionLogger;
}

/**
 * Финальный аудит-вентиль: проверяет, что текстовый ответ действительно
 * выполнил задачу (при активном плане/скрипте), прежде чем принять его.
 *
 * Отклонение переспрашивает модель через <system-summary> и взводит
 * suppressRepetitionRetry — повторный ответ на выполненную задачу
 * естественно "повторяющийся" и не должен жечь бюджет халлюцинаций.
 * Исчерпание повторов (MAX_AUDIT_RETRIES или упор в лимит итераций)
 * переводит цикл в состояние auditFailed → success:false.
 */
export class AuditGate {
  constructor(
    private readonly finalAudit: (() => Promise<FinalAuditResult | null>) | undefined,
  ) {}

  /**
   * Оценивает ответ через финальный аудит.
   * @param deps состояние цикла и окружение; @returns вердикт либо null (аудит не настроен).
   */
  async evaluate(deps: AuditGateDeps): Promise<AuditVerdict | null> {
    if (!this.finalAudit) return null;
    const audit = await this.finalAudit();
    if (!audit || audit.passed) return { action: "pass" };

    const { state, logger, contextManager } = deps;
    state.iterAuditRejection = true;
    logger.diagnostic("warn", `Final audit incomplete: ${audit.summary}`);

    const steps = audit.pendingSteps.slice(0, 5).join("; ") || "—";
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${t("exec.audit_incomplete", {
        summary: audit.summary,
        steps,
      })}</system-summary>`,
    });
    deps.slog.logAudit(audit.summary, deps.iteration);

    state.auditRetries++;
    state.lastAuditSummary = audit.summary;

    if (state.auditRetries >= MAX_AUDIT_RETRIES || deps.iteration >= deps.maxIterations - 1) {
      logger.diagnostic(
        "warn",
        `Final audit still incomplete after ${state.auditRetries} retries — reporting failure`,
      );
      state.auditFailed = true;
      return { action: "exhausted", summary: audit.summary };
    }

    // Следующий текстовый ответ — принудительный повтор уже выполненной
    // задачи: разрешаем одну повторность без халлюцинационного повтора.
    state.suppressRepetitionRetry = true;
    return { action: "reject" };
  }
}