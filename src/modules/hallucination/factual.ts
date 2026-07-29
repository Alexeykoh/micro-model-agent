export interface HallucinationCheckResult {
  status: 'pass' | 'warn' | 'retry' | 'block'
  reason?: string
}

export class FactualCheck {
  private knownPaths: Set<string> = new Set()
  private createdPaths: Set<string> = new Set()

  trackReadPath(path: string): void {
    this.knownPaths.add(path)
  }

  trackCreatedPath(path: string): void {
    this.knownPaths.add(path)
    this.createdPaths.add(path)
  }

  validate(response: string): HallucinationCheckResult {
    const pathRegex = /[\w\-./]+\.\w+/g
    const mentionedPaths = response.match(pathRegex) || []

    const unknownPaths = mentionedPaths.filter(p => {
      if (this.knownPaths.has(p)) return false
      if (p.startsWith('http')) return false
      return true
    })

    if (unknownPaths.length > 0) {
      return {
        status: 'warn',
        reason: `Unknown paths mentioned: ${unknownPaths.slice(0, 3).join(', ')}`,
      }
    }

    return { status: 'pass' }
  }
}
