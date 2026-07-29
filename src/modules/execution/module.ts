import type { AgentModule } from '../types'
import type { PromptBlock } from '../../core/types'
import type { ToolDefinition } from '../../tools/types'
import type { AgentPlugin } from '../types'
import { t } from '../../i18n/index'
import { PlanCreator } from './planner'
import { PlanTracker } from './tracker'
import { StepVerifier } from './verifier'
import { StuckDetector } from './stuck-detector'
import { Auditor } from './auditor'
import type { Plan } from './planner'

export class ExecutionModule implements AgentModule {
  name = 'execution'
  private tracker: PlanTracker | null = null
  private verifier: StepVerifier
  private stuckDetector: StuckDetector
  private auditor: Auditor

  constructor(baseDir: string, stuckThreshold = 8) {
    this.verifier = new StepVerifier(baseDir)
    this.stuckDetector = new StuckDetector(stuckThreshold)
    this.auditor = new Auditor(baseDir)
  }

  setPlan(plan: Plan): void {
    this.tracker = new PlanTracker(plan)
  }

  getTracker(): PlanTracker | null {
    return this.tracker
  }

  getStuckDetector(): StuckDetector {
    return this.stuckDetector
  }

  getSystemPromptBlock(): PromptBlock | null {
    if (!this.tracker) return null
    return {
      content: this.tracker.toPromptBlock(),
      priority: 'critical',
      essential: true,
      estimatedTokens: 200,
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'plan',
        description: 'Create, update, or abort a multi-step plan. System calls create automatically for multi-step tasks. Model calls update after each step.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'update', 'abort'] },
            title: { type: 'string' },
            steps: { type: 'array', items: { type: 'string' } },
            step: { type: 'number' },
            status: { type: 'string', enum: ['done', 'failed', 'skipped'] },
            note: { type: 'string' },
          },
          required: ['action'],
        },
        handler: async (_ctx, args) => {
          const action = String(args.action)
          if (action === 'update' && args.step && this.tracker) {
            this.tracker.updateStepStatus(Number(args.step), (args.status as any) || 'done')
            if (args.note) this.tracker.addNote(Number(args.step), String(args.note))
            return { success: true, output: t('plan.step_status', { step: String(args.step), status: String(args.status || 'done') }) }
          }
          return { success: true, output: t('plan.acknowledged', { action }) }
        },
      },
      {
        name: 'todo',
        description: 'Manage sub-tasks within a plan step.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'done', 'list'] },
            items: { type: 'array', items: { type: 'string' } },
          },
          required: ['action'],
        },
        handler: async () => ({ success: true, output: t('todo.acknowledged') }),
      },
      {
        name: 'verify',
        description: 'Run verification for the current step. Checks files mentioned in the step description.',
        parameters: {
          type: 'object',
          properties: {
            step: { type: 'number', description: 'Step number to verify' },
          },
        },
        handler: async (_ctx, args) => {
          if (!this.tracker) return { success: false, output: t('plan.no_active') }
          const step = args.step ? this.tracker.getStep(Number(args.step)) : this.tracker.getCurrentStep()
          if (!step) return { success: false, output: t('plan.step_not_found') }
          const result = await this.verifier.verifyStep(step.description)
          return {
            success: result.passed,
            output: result.passed
              ? t('verify.passed')
              : t('verify.failed', { details: result.failed.map(f => f.message).join('; ') }),
          }
        },
      },
    ]
  }

  getPlugin(): AgentPlugin {
    return {
      name: 'execution',
      onBeforeThink: (ctx: any) => {
        this.stuckDetector.recordIteration(ctx.currentStep || 0)
        const stuckReason = this.stuckDetector.getStuckReason()
        if (stuckReason) {
          ctx.logger?.warn(stuckReason)
        }
      },
      onAfterTool: (ctx: any, result: any) => {
        if (!result.success) {
          this.stuckDetector.recordToolError('tool')
        }
      },
    }
  }
}
