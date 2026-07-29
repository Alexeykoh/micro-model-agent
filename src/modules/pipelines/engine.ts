import type { PipelineStep } from './parser'

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export class PipelineEngine {
  private stepStatus: Map<string, StepStatus> = new Map()

  resolveDependencies(steps: PipelineStep[]): string[] {
    const visited = new Set<string>()
    const inStack = new Set<string>()
    const order: string[] = []

    function visit(stepId: string, stepMap: Map<string, PipelineStep>): void {
      if (inStack.has(stepId)) throw new Error(`Circular dependency: ${stepId}`)
      if (visited.has(stepId)) return

      inStack.add(stepId)
      const step = stepMap.get(stepId)
      if (step?.depends_on) {
        for (const dep of step.depends_on) {
          visit(dep, stepMap)
        }
      }
      inStack.delete(stepId)
      visited.add(stepId)
      order.push(stepId)
    }

    const stepMap = new Map(steps.map(s => [s.id, s]))
    for (const step of steps) {
      if (!visited.has(step.id)) {
        visit(step.id, stepMap)
      }
    }

    return order
  }

  getReadySteps(steps: PipelineStep[], completed: Set<string>): PipelineStep[] {
    return steps.filter(s => {
      if (completed.has(s.id)) return false
      if (this.stepStatus.get(s.id) === 'running') return false
      if (this.stepStatus.get(s.id) === 'failed') return false
      if (!s.depends_on || s.depends_on.length === 0) return true
      return s.depends_on.every(d => completed.has(d))
    })
  }

  setStepStatus(stepId: string, status: StepStatus): void {
    this.stepStatus.set(stepId, status)
  }

  getStepStatus(stepId: string): StepStatus {
    return this.stepStatus.get(stepId) || 'pending'
  }

  isComplete(stepIds: string[]): boolean {
    return stepIds.every(id => {
      const s = this.stepStatus.get(id)
      return s === 'done' || s === 'skipped'
    })
  }

  reset(): void {
    this.stepStatus.clear()
  }
}
