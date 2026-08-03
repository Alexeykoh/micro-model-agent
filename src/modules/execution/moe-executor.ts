import type { MoEPlan, MoESubtask, SubtaskResult, PlanResult } from './types'
import type { AppConfig, ExpertConfig } from '../../config/types'
import { getExpertConfig } from '../../config/experts'
import { filterToolsByTags } from '../../tools/filter-tools'
import type { ToolRegistry } from '../../tools/registry'
import type { LLMProvider } from '../../llm/provider'
import type { Logger } from '../../logger/app-logger'

const TRANSIENT_ERROR_PATTERNS = [
  'timeout', 'Timeout', 'TIMEOUT',
  '5xx', '500', '502', '503',
  'network', 'Network',
  'ECONNREFUSED', 'ECONNRESET',
  'fetch failed',
  'abort', 'Abort',
]

function isTransientError(error: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some(p => error.includes(p))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export interface MoEExecutorDeps {
  config: AppConfig
  toolRegistry: ToolRegistry
  toolExecutor: import('../../tools/executor').ToolExecutor
  llmProvider: LLMProvider
  logger: Logger
  baseDir: string
}

export function topologicalSort(subtasks: MoESubtask[]): MoESubtask[][] {
  const sorted: MoESubtask[][] = []
  const remaining = new Set(subtasks.map(s => s.id))
  const subtaskMap = new Map(subtasks.map(s => [s.id, s]))

  while (remaining.size > 0) {
    const ready: MoESubtask[] = []
    for (const id of remaining) {
      const sub = subtaskMap.get(id)!
      const depsSatisfied = (sub.depends_on || []).every(d => !remaining.has(d))
      if (depsSatisfied) {
        ready.push(sub)
      }
    }

    if (ready.length === 0) {
      break
    }

    sorted.push(ready)
    for (const r of ready) {
      remaining.delete(r.id)
    }
  }

  return sorted
}

async function executeSubtask(
  subtask: MoESubtask,
  deps: MoEExecutorDeps,
  _sharedContext: MoEPlan['shared_context'],
): Promise<SubtaskResult> {
  const startTime = Date.now()
  const expertConfig: ExpertConfig | undefined = getExpertConfig(deps.config, subtask.expert_tag)

  if (!expertConfig) {
    return {
      subtaskId: subtask.id,
      success: false,
      summary: `Unknown expert_tag: ${subtask.expert_tag}`,
      result: '',
      error: `No expert config found for tag "${subtask.expert_tag}"`,
      durationMs: Date.now() - startTime,
    }
  }

  const subagentTool = deps.toolRegistry.get('subagent')
  if (!subagentTool) {
    return {
      subtaskId: subtask.id,
      success: false,
      summary: 'Subagent tool not registered',
      result: '',
      error: 'Subagent tool not found in registry',
      durationMs: Date.now() - startTime,
    }
  }

  const allTools = deps.toolRegistry.getAll()
  const filteredTools = filterToolsByTags(allTools, expertConfig.tool_tags)

  if (filteredTools.length === 0) {
    return {
      subtaskId: subtask.id,
      success: false,
      summary: `No tools available for expert "${subtask.expert_tag}" (tags: ${expertConfig.tool_tags.join(', ')})`,
      result: '',
      error: 'No matching tools',
      durationMs: Date.now() - startTime,
    }
  }

  const maxAttempts = expertConfig.max_attempts || 3
  let lastError = ''
  let lastResult: any = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const allowedFiles = subtask.allowed_files || []
      const readOnlyFiles = subtask.read_only_files || []

      const scopePrompt = allowedFiles.length > 0 || readOnlyFiles.length > 0
        ? `\n\nAllowed files to write: ${allowedFiles.join(', ') || '(none)'}\nRead-only files: ${readOnlyFiles.join(', ') || '(none)'}`
        : ''

      const taskPrompt = `${subtask.description}\n\nExpected output: ${subtask.expected_output}\nSuccess criteria:\n${(subtask.success_criteria || []).map((c: string) => `- ${c}`).join('\n')}${scopePrompt}`

      const subagentArgs: Record<string, unknown> = {
        task: taskPrompt,
        allowed_files: allowedFiles,
        read_only_files: readOnlyFiles,
        tool_tags: expertConfig.tool_tags,
      }

      const result = await subagentTool.handler(
        {
          config: deps.config,
          baseDir: deps.baseDir,
          logger: deps.logger,
          llmProvider: deps.llmProvider,
          toolExecutor: deps.toolExecutor,
        },
        subagentArgs,
      )

      if (result.success) {
        return {
          subtaskId: subtask.id,
          success: true,
          summary: `Completed: ${subtask.id}`,
          result: result.output,
          durationMs: Date.now() - startTime,
        }
      }

      lastError = result.output
      lastResult = result

      if (isTransientError(lastError) && attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000)
        deps.logger.debug(`Retrying subtask "${subtask.id}" (attempt ${attempt}/${maxAttempts}) after ${delay}ms: transient error`)
        await sleep(delay)
        continue
      }

      return {
        subtaskId: subtask.id,
        success: false,
        summary: `Failed: ${subtask.id}`,
        result: result.output,
        error: result.output,
        durationMs: Date.now() - startTime,
      }
    } catch (e: any) {
      lastError = e.message

      if (isTransientError(lastError) && attempt < maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000)
        deps.logger.debug(`Retrying subtask "${subtask.id}" (attempt ${attempt}/${maxAttempts}) after ${delay}ms: ${lastError}`)
        await sleep(delay)
        continue
      }

      return {
        subtaskId: subtask.id,
        success: false,
        summary: `Error: ${subtask.id}`,
        result: '',
        error: e.message,
        durationMs: Date.now() - startTime,
      }
    }
  }

  return {
    subtaskId: subtask.id,
    success: false,
    summary: `Failed after ${maxAttempts} attempts: ${subtask.id}`,
    result: '',
    error: lastError,
    durationMs: Date.now() - startTime,
  }
}

export class MoEExecutor {
  private deps: MoEExecutorDeps

  constructor(deps: MoEExecutorDeps) {
    this.deps = deps
  }

  async executePlan(plan: MoEPlan): Promise<PlanResult> {
    const results: SubtaskResult[] = []
    const errors: string[] = []
    const warnings: string[] = []

    const waves = topologicalSort(plan.subtasks)

    if (waves.length === 0) {
      return { success: false, results: [], errors: ['Failed to topologically sort subtasks (possible cycle)'], warnings: [] }
    }

    // Verify all subtasks are included — catch silent drops from unresolved dependencies
    const sortedCount = waves.flat().length
    if (sortedCount < plan.subtasks.length) {
      const missing = plan.subtasks
        .filter(s => !waves.flat().some(w => w.id === s.id))
        .map(s => s.id)
      return {
        success: false,
        results: [],
        errors: [`Missing subtasks after topological sort: ${missing.join(', ')} (dangling or invalid depends_on)`],
        warnings: [],
      }
    }

    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx]

      const wavePromises = wave.map(subtask =>
        executeSubtask(subtask, this.deps, plan.shared_context)
          .then(result => {
            results.push(result)
            return result
          })
          .catch(e => {
            const errResult: SubtaskResult = {
              subtaskId: subtask.id,
              success: false,
              summary: `Unhandled error: ${subtask.id}`,
              result: '',
              error: e.message,
              durationMs: 0,
            }
            results.push(errResult)
            return errResult
          })
      )

      await Promise.all(wavePromises)
    }

    const failed = results.filter(r => !r.success)
    if (failed.length > 0) {
      errors.push(...failed.map(f => `[${f.subtaskId}] ${f.error || f.summary}`))
    }

    return { success: failed.length === 0, results, errors, warnings }
  }

  getChainMaxAttempts(): number {
    return 3
  }
}
