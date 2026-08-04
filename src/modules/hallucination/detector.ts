import { ConsistencyCheck } from "./consistency";
import { ConfidenceCheck } from "./confidence";

export interface HallucinationCheckResult {
  status: "pass" | "warn" | "retry" | "block";
  reason?: string;
}

export class HallucinationDetector {
  private consistency: ConsistencyCheck;
  private confidence: ConfidenceCheck;

  constructor() {
    this.consistency = new ConsistencyCheck();
    this.confidence = new ConfidenceCheck();
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
