import { t } from '../../i18n/index'

interface ToolCallRecord {
  name: string
  argsKey: string
}

export class StuckDetector {
  private threshold: number
  private errorThreshold: number
  private iterationsOnCurrentStep = 0
  private currentStepId: number | null = null
  private toolErrors: Map<string, number> = new Map()
  private currentStepDescription = ''
  private recentToolCalls: ToolCallRecord[] = []
  private readonly maxRecentCalls = 10
  private readonly repetitionThreshold = 3

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

  recordToolCall(name: string, args: Record<string, unknown>): void {
    const argsKey = JSON.stringify(args)
    this.recentToolCalls.push({ name, argsKey })
    if (this.recentToolCalls.length > this.maxRecentCalls) {
      this.recentToolCalls.shift()
    }
  }

  recordToolError(toolName: string): void {
    this.toolErrors.set(toolName, (this.toolErrors.get(toolName) || 0) + 1)
  }

  setCurrentStep(stepId: number, description: string): void {
    if (stepId !== this.currentStepId) {
      this.currentStepId = stepId
      this.iterationsOnCurrentStep = 1
    }
    this.currentStepDescription = description
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

  hasRepetitiveToolCalls(): boolean {
    if (this.recentToolCalls.length < this.repetitionThreshold) return false
    const last = this.recentToolCalls[this.recentToolCalls.length - 1]
    let count = 1
    for (let i = this.recentToolCalls.length - 2; i >= 0; i--) {
      if (this.recentToolCalls[i].name === last.name && this.recentToolCalls[i].argsKey === last.argsKey) {
        count++
      } else {
        break
      }
    }
    return count >= this.repetitionThreshold
  }

  getRepetitiveToolMessage(): string {
    if (!this.hasRepetitiveToolCalls()) return ''
    const last = this.recentToolCalls[this.recentToolCalls.length - 1]
    return t('exec.repetitive_tool', { tool: last.name, count: this.repetitionThreshold })
  }

  getStuckReason(): string {
    if (this.isStuck()) {
      return t('exec.stuck', { stepId: String(this.currentStepId), description: this.currentStepDescription, iterations: this.iterationsOnCurrentStep })
    }
    const errorTool = Array.from(this.toolErrors.entries()).find(([_, c]) => c >= this.errorThreshold)
    if (errorTool) {
      return t('exec.tool_errors', { tool: errorTool[0], count: errorTool[1] })
    }
    return ''
  }

  getRecoveryMessage(): string {
    if (this.isStuck()) {
      return t('exec.stuck_recovery', { iterations: this.iterationsOnCurrentStep })
    }
    if (this.hasRepetitiveToolCalls()) {
      return this.getRepetitiveToolMessage()
    }
    const errorTool = Array.from(this.toolErrors.entries()).find(([_, c]) => c >= this.errorThreshold)
    if (errorTool) {
      return t('exec.tool_errors_recovery', { tool: errorTool[0], count: errorTool[1] })
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
      return t('exec.off_track', { stepId: String(this.currentStepId), description: this.currentStepDescription, tool: toolName })
    }

    return null
  }

  reset(): void {
    this.iterationsOnCurrentStep = 0
    this.toolErrors.clear()
  }
}
