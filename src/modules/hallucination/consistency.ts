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
      const contradicts = decisionWords.some(word => {
        // English patterns
        if (lower.includes(`instead of ${word}`)) return true
        if (lower.includes(`not ${word}`)) return true
        if (lower.includes(`replacing ${word} with`)) return true
        if (lower.includes(`switching to`)) return true
        if (lower.includes(`changing from ${word}`)) return true
        if (lower.includes(`abandoning ${word}`)) return true
        // Russian patterns
        if (lower.includes(`вместо ${word}`)) return true
        if (lower.includes(`заменяя ${word}`)) return true
        if (lower.includes(`заменяем ${word}`)) return true
        if (lower.includes(`переключаемся на`)) return true
        if (lower.includes(`от ${word} к`)) return true
        if (lower.includes(`отказываемся от ${word}`)) return true
        return false
      })
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
