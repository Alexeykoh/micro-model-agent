import type { HallucinationCheckResult } from './factual'
import { t } from '../../i18n/index'

export class ConsistencyCheck {
  private decisions: Array<{ decision: string; location: string }> = []
  private createdFiles: Set<string> = new Set()
  private deletedFiles: Set<string> = new Set()

  trackDecision(decision: string, location: string): void {
    this.decisions.push({ decision, location })
  }

  trackCreatedFile(path: string): void {
    this.createdFiles.add(path)
  }

  trackDeletedFile(path: string): void {
    this.deletedFiles.add(path)
  }

  getCreatedFiles(): string[] {
    return Array.from(this.createdFiles)
  }

  validate(response: string): HallucinationCheckResult {
    const lower = response.toLowerCase()

    for (const d of this.decisions) {
      const decisionWords = d.decision.toLowerCase().split(/\s+/).filter(w => w.length > 3)
      const contradicts = decisionWords.some(word =>
        lower.includes(`instead of ${word}`) || lower.includes(`not ${word}`)
      )
      if (contradicts) {
        return {
          status: 'warn',
          reason: t('hall.contradiction', { decision: d.decision, location: d.location }),
        }
      }
    }

    return { status: 'pass' }
  }
}
