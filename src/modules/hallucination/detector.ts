import { ConsistencyCheck } from "./consistency";
import { ConfidenceCheck } from "./confidence";
import { FactualCheck } from "./factual";

export interface HallucinationCheckResult {
  status: "pass" | "warn" | "retry" | "block";
  reason?: string;
}

export class HallucinationDetector {
  private consistency: ConsistencyCheck;
  private confidence: ConfidenceCheck;
  private factual: FactualCheck | null;

  constructor(baseDir?: string) {
    this.consistency = new ConsistencyCheck();
    this.confidence = new ConfidenceCheck();
    this.factual = baseDir ? new FactualCheck(baseDir) : null;
  }

  getConsistencyCheck(): ConsistencyCheck {
    return this.consistency;
  }

  getConfidenceCheck(): ConfidenceCheck {
    return this.confidence;
  }

  validate(response: string): HallucinationCheckResult {
    const confidenceResult = this.confidence.validate(response);
    if (
      confidenceResult.status === "retry" ||
      confidenceResult.status === "block"
    ) {
      return confidenceResult;
    }

    const factualResult = this.factual?.validate(response);
    if (factualResult && factualResult.status !== "pass") {
      return factualResult;
    }

    const consistencyResult = this.consistency.validate(response);

    const warnings: string[] = [];
    if (consistencyResult.status === "warn")
      warnings.push(consistencyResult.reason || "");
    if (confidenceResult.status === "warn")
      warnings.push(confidenceResult.reason || "");

    if (warnings.length > 0) {
      return { status: "warn", reason: warnings.join("; ") };
    }

    return { status: "pass" };
  }
}
