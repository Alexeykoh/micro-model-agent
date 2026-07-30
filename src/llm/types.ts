import type { MoEPlan } from '../modules/execution/types'

export interface OrchestratorResult {
  type: 'plan' | 'final' | 'replan'
  plan?: MoEPlan
  finalAnswer?: string
  explanation?: string
}

export interface SubtaskResult {
  subtaskId: string
  success: boolean
  summary: string
  result: string
  error?: string
}

export interface VerifyInput {
  plan: MoEPlan
  results: SubtaskResult[]
  verifierErrors: string[]
  verifierWarnings: string[]
}
