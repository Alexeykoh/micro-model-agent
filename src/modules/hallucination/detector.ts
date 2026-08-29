import { ConsistencyCheck } from "./consistency";
import { ConfidenceCheck } from "./confidence";
import { FactualCheck } from "./factual";
import { LLMJudge } from "./llm-judge";
import type { LLMProvider } from "../../llm/provider";

export interface HallucinationCheckResult {
  status: "pass" | "warn" | "retry" | "block";
  reason?: string;
  /** What kind of signal triggered the verdict (used to distinguish a
   *  repetition-retry from a short/empty one — the audit gate can legitimately
   *  force a repetitive re-answer and should not burn a retry on it). */
  kind?: "short" | "repetition" | "diversity";
}

export class HallucinationDetector {
  private consistency: ConsistencyCheck;
  private confidence: ConfidenceCheck;
  private factual: FactualCheck | null;
  private judge: LLMJudge | null;

  constructor(
    baseDir?: string,
    llmProvider?: LLMProvider,
    options?: { judgeEnabled?: boolean },
  ) {
    this.consistency = new ConsistencyCheck();
    this.confidence = new ConfidenceCheck();
    this.factual = baseDir ? new FactualCheck(baseDir) : null;
    // The judge is opt-out: it only runs when a provider is supplied AND the
    // caller did not explicitly disable it (the main agent disables it by
    // default via config.hallucination.judge.enabled).
    const judgeEnabled = options?.judgeEnabled ?? true;
    this.judge = llmProvider && judgeEnabled ? new LLMJudge(llmProvider) : null;
  }

  getConsistencyCheck(): ConsistencyCheck {
    return this.consistency;
  }

  getConfidenceCheck(): ConfidenceCheck {
    return this.confidence;
  }

  /** Add files known from compaction summaries to the factual checker. */
  addKnownFiles(files: string[]): void {
    this.factual?.addKnownFiles(files);
  }

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

    // LLM-as-judge consistency: fast path (no decisions) skips any LLM call.
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
