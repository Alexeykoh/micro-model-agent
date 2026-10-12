// Оркестратор проверок галлюцинаций: confidence → factual → LLM-судья.
import { ConsistencyCheck } from "./consistency";
import { ConfidenceCheck } from "./confidence";
import { FactualCheck } from "./factual";
import { LLMJudge } from "./llm-judge";
import type { LLMProvider } from "../../llm/provider";

/** Результат проверки: вердикт + опциональные причина и тип сигнала. */
export interface HallucinationCheckResult {
  status: "pass" | "warn" | "retry" | "block";
  reason?: string;
  /** Тип сработавшего сигнала (различает повтор-retry от короткого/пустого —
   *  audit-gate может легитимно форсировать повторный ответ и не должен жечь retry). */
  kind?: "short" | "repetition" | "diversity";
}

/** Детектор галлюцинаций: объединяет проверки уверенности, фактов и LLM-судью. */
export class HallucinationDetector {
  private consistency: ConsistencyCheck;
  private confidence: ConfidenceCheck;
  private factual: FactualCheck | null;
  private judge: LLMJudge | null;

  constructor(
    baseDir?: string,
    llmProvider?: LLMProvider,
    options?: { judgeEnabled?: boolean; sessionId?: string },
  ) {
    this.consistency = new ConsistencyCheck();
    this.confidence = new ConfidenceCheck();
    this.factual = baseDir ? new FactualCheck(baseDir) : null;
    // Судья opt-out: работает только если передан провайдер И вызывающий явно
    // его не отключил (главный агент отключает по умолчанию через
    // config.hallucination.judge.enabled).
    const judgeEnabled = options?.judgeEnabled ?? true;
    this.judge =
      llmProvider && judgeEnabled ? new LLMJudge(llmProvider, options?.sessionId) : null;
  }

  /** Доступ к проверке консистентности (решения, созданные/удалённые файлы). */
  getConsistencyCheck(): ConsistencyCheck {
    return this.consistency;
  }

  /** Доступ к проверке уверенности (повторы, diversity). */
  getConfidenceCheck(): ConfidenceCheck {
    return this.confidence;
  }

  /** Добавляет файлы, известные из сводок компакции, в фактическую проверку. */
  addKnownFiles(files: string[]): void {
    this.factual?.addKnownFiles(files);
  }

  /** Валидирует ответ: retry/block уверенности → факты → LLM-судья + warn-агрегация. */
  async validate(response: string): Promise<HallucinationCheckResult> {
    const confidenceResult = this.confidence.validate(response);
    if (confidenceResult.status === "retry" || confidenceResult.status === "block") {
      return confidenceResult;
    }

    const deletedFiles = new Set(this.consistency.getDeletedFiles());
    const factualResult = this.factual?.validate(response, deletedFiles);
    if (factualResult && factualResult.status !== "pass") {
      return factualResult;
    }

    // Судья по консистентности (LLM): быстрый путь (нет решений) — без LLM-вызова.
    const judgeResult = this.judge ? await this.judge.validate(response, this.consistency) : null;

    const warnings: string[] = [];
    if (judgeResult && judgeResult.status === "warn") warnings.push(judgeResult.reason || "");
    if (confidenceResult.status === "warn") warnings.push(confidenceResult.reason || "");

    if (warnings.length > 0) {
      return { status: "warn", reason: warnings.join("; ") };
    }

    return { status: "pass" };
  }
}
