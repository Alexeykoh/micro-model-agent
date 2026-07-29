export type StepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped'

export interface PlanStep {
  id: number
  description: string
  status: StepStatus
  note?: string
}

export interface Plan {
  title: string
  steps: PlanStep[]
  createdAt: string
}

export class PlanCreator {
  static isMultiStep(task: string): boolean {
    const fileCount = (task.match(/\b[\w./-]+\.[a-z]+\b/gi) || []).length
    if (fileCount > 1) return true

    const actionWords = ['implement', 'create', 'add', 'build', 'setup', 'configure', 'write', 'make', 'develop']
    const words = task.split(/\s+/)
    const hasActionWord = actionWords.some(w => task.toLowerCase().includes(w))

    return hasActionWord && words.length > 8
  }

  static createPlan(title: string, stepDescriptions: string[]): Plan {
    return {
      title,
      steps: stepDescriptions.map((desc, i) => ({
        id: i + 1,
        description: desc,
        status: 'pending' as StepStatus,
      })),
      createdAt: new Date().toISOString(),
    }
  }

  static toPromptBlock(plan: Plan, currentStepIndex: number): string {
    const lines: string[] = [`[Plan: ${plan.title}] (steps: ${plan.steps.filter(s => s.status === 'done').length}/${plan.steps.length} done, current: step ${currentStepIndex + 1})`]
    for (const step of plan.steps) {
      const icon = step.status === 'done' ? '[x]' :
                   step.status === 'in_progress' ? '[*]' :
                   step.status === 'failed' ? '[!]' :
                   step.status === 'skipped' ? '[-]' :
                   '[ ]'
      const note = step.note ? ` — ${step.note}` : ''
      lines.push(`${icon} ${step.id}. ${step.description}${note}`)
    }
    return lines.join('\n')
  }
}
