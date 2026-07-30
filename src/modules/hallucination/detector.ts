import { FactualCheck, type HallucinationCheckResult } from './factual'
import { ConsistencyCheck } from './consistency'
import { ConfidenceCheck } from './confidence'

export class HallucinationDetector {
  private factual: FactualCheck
  private consistency: ConsistencyCheck
  private confidence: ConfidenceCheck

  constructor() {
    this.factual = new FactualCheck()
    this.consistency = new ConsistencyCheck()
    this.confidence = new ConfidenceCheck()
  }

  getFactualCheck(): FactualCheck {
    return this.factual
  }

  getConsistencyCheck(): ConsistencyCheck {
    return this.consistency
  }

  getConfidenceCheck(): ConfidenceCheck {
    return this.confidence
  }

  validate(response: string): HallucinationCheckResult {
    const confidenceResult = this.confidence.validate(response)
    if (confidenceResult.status === 'retry' || confidenceResult.status === 'block') {
      return confidenceResult
    }

    const factualResult = this.factual.validate(response)
    const consistencyResult = this.consistency.validate(response)

    const warnings: string[] = []
    if (factualResult.status === 'warn') warnings.push(factualResult.reason || '')
    if (consistencyResult.status === 'warn') warnings.push(consistencyResult.reason || '')
    if (confidenceResult.status === 'warn') warnings.push(confidenceResult.reason || '')

    if (warnings.length > 0) {
      return { status: 'warn', reason: warnings.join('; ') }
    }

    return { status: 'pass' }
  }
}
