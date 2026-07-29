export class StuckDetector {
  private threshold: number
  private errorThreshold: number
  private iterationsOnCurrentStep = 0
  private currentStepId: number | null = null
  private toolErrors: Map<string, number> = new Map()
  private currentStepDescription = ''

  constructor(threshold = 8, errorThreshold = 3) {
    this.threshold = threshold
    this.errorThreshold = errorThreshold
  }

  recordIteration(stepId: number): void {
    if (stepId === this.currentStepId) {
      this.iterationsOnCurrentStep++
    } else {
      this.currentStepId = stepId
      this.iterationsOnCurrentStep = 1
    }
  }

  recordToolError(toolName: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1)
  }

  setCurrentStep(stepId: number, description: string): void {
    this.currentStepId = stepId
    this.currentStepDescription = description
    this.iterationsOnCurrentStep = 1
  }

  isStuck(): boolean {
    return this.iterationsOnCurrentStep > this.threshold
  }

  hasRepetitiveErrors(toolName?: string): boolean {
    if (toolName) {
      return (this.toolErrors.get(toolName) || 0) >= this.errorThreshold
    }
    return Array.from(this.toolErrors.values()).some(c => c >= this.errorThreshold)
  }

  getStuckReason(): string {
    if (this.isStuck()) {
      return `Stuck on step ${this.currentStepId}. Current: ${this.currentStepDescription}. No progress for ${this.iterationsOnCurrentStep} iterations.`
    }
    const errorTool = Array.from(this.toolErrors.entries()).find(([_, c]) => c >= this.errorThreshold)
    if (errorTool) {
      return `Tool ${errorTool[0]} failed ${errorTool[1]} times. Suggest alternative approach.`
    }
    return ''
  }

  checkOffTrack(toolName: string, call: { name: string; arguments: Record<string, unknown> }): string | null {
    if (!this.currentStepDescription) return null

    const toolArgStr = JSON.stringify(call.arguments).toLowerCase()

    const pathInStep = (this.currentStepDescription.match(/\b[\w./-]+\.[a-z]+/gi) || [])
      .map(p => p.toLowerCase())

    const pathInCall = (toolArgStr.match(/\b[\w./-]+\.[a-z]+/gi) || [])
      .map(p => p.toLowerCase())

    const overlaps = pathInCall.some(p => pathInStep.some(s => p.includes(s) || s.includes(p)))

    if (!overlaps && pathInStep.length > 0 && pathInCall.length > 0) {
      return `[⚠ Outside plan: step ${this.currentStepId} is "${this.currentStepDescription}", but you're using ${toolName} on a different path. Explain or return.]`
    }

    return null
  }

  reset(): void {
    this.iterationsOnCurrentStep = 0
    this.toolErrors.clear()
  }
}
