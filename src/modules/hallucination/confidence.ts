import type { HallucinationCheckResult } from './factual'
import { t } from '../../i18n/index'

const UNCERTAINTY_MARKERS = ['i think', 'maybe', 'probably', 'i believe', 'not sure', 'might be']
const MIN_CHARS = 5

export class ConfidenceCheck {
  private previousResponse: string = ''

  setPreviousResponse(response: string): void {
    this.previousResponse = response
  }

  validate(response: string): HallucinationCheckResult {
    if (!response || response.length < MIN_CHARS) {
      return { status: 'retry', reason: t('hall.short_response') }
    }

    if (this.previousResponse) {
      const overlap = this.calculateOverlap(response, this.previousResponse)
      if (overlap > 0.5) {
        return { status: 'retry', reason: t('hall.repetitive', { pct: Math.round(overlap * 100) }) }
      }
    }

    const lower = response.toLowerCase()
    const foundMarkers = UNCERTAINTY_MARKERS.filter(m => lower.includes(m))
    if (foundMarkers.length > 0) {
      return { status: 'warn', reason: t('hall.uncertainty', { markers: foundMarkers.join(', ') }) }
    }

    return { status: 'pass' }
  }

  private calculateOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/))
    const wordsB = b.toLowerCase().split(/\s+/)
    if (wordsB.length === 0) return 0
    const matches = wordsB.filter(w => wordsA.has(w))
    return matches.length / wordsB.length
  }
}
