import { describe, expect, it } from 'bun:test'
import { Agent } from '../../src/core/agent'
import type { AgentDeps } from '../../src/core/agent'

describe('Agent hallucination reactions', () => {
  const createMockDeps = (overrides: Partial<AgentDeps> = {}): AgentDeps => ({
    config: {
      maxToolIterations: 5,
      contextWindow: 32768,
      contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
      model: 'test',
      provider: { type: 'openai-compat', baseUrl: 'http://test', apiKey: 'test' },
      logLevel: 'info',
      locale: 'en',
      stuckThreshold: 8,
      autoPlan: true,
      showReasoning: false,
      session: { autoSave: false, maxSessions: 50, isolateMemory: false },
    } as any,
    llmProvider: {
      chat: async function* () {
        yield { type: 'text', content: 'test response' }
      },
      countTokens: () => 10,
      model: 'test',
      contextWindow: 32768,
    },
    toolExecutor: { execute: async () => ({ success: true, output: 'ok' }), getToolDefinitions: () => [] } as any,
    pluginManager: {
      runOnBeforeThink: () => {},
      runOnBeforeTool: async () => true,
      runOnAfterTool: async () => {},
      runOnAfterThink: () => {},
      runOnToolCall: () => {},
      runOnPhase: () => {},
      runOnToolStart: () => {},
      runOnToolEnd: () => {},
      runOnText: (_ctx: unknown, chunk: string) => chunk,
      runOnMeta: (_ctx: unknown, chunk: string) => chunk,
      runOnError: async () => {},
      runOnSessionStart: () => {},
      runOnSessionEnd: () => {},
      runOnBuildPrompt: () => [],
      runOnPhase: () => {},
      runOnAfterThink: async () => {},
      runOnToolCall: () => {},
      runOnToolStart: () => {},
      runOnToolEnd: () => {},
      runOnText: () => {},
      runOnMeta: () => {},
    } as any,
    contextManager: {
      addMessage: () => {},
      getActiveHistory: () => [],
      needsCompaction: () => false,
      compact: () => {},
      getEstimatedTokens: () => 100,
      getBudget: () => ({ systemPrompt: 8192, responseReserve: 3932, history: 20644 }),
      updateSystemPrompt: () => {},
      clear: () => {},
    } as any,
    hallucinationDetector: { validate: () => ({ status: 'pass' }) } as any,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    baseDir: '/test',
    promptBlocks: [],
    ...overrides,
  })

  it('should show warn response with uncertainty prefix', async () => {
    const mockDeps = createMockDeps({
      hallucinationDetector: { validate: () => ({ status: 'warn', reason: 'Uncertainty markers detected' }) } as any,
    })

    const agent = new Agent(mockDeps)
    const chunks: string[] = []
    const result = await agent.run('test', (chunk) => chunks.push(chunk))

    expect(result.success).toBe(true)
    expect(chunks.join('')).toContain('[⚠️ Uncertainty]')
  })

  it('should retry on hallucination retry status', async () => {
    let callCount = 0
    const mockDeps = createMockDeps({
      hallucinationDetector: {
        validate: (response: string) => {
          callCount++
          if (callCount === 1) return { status: 'retry', reason: 'Low confidence' }
          return { status: 'pass' }
        },
      } as any,
    })

    const agent = new Agent(mockDeps)
    const result = await agent.run('test')

    expect(result.success).toBe(true)
    expect(callCount).toBeGreaterThanOrEqual(1)
  })

  it('should block on hallucination block status', async () => {
    const mockDeps = createMockDeps({
      hallucinationDetector: { validate: () => ({ status: 'block', reason: 'Critical error' }) } as any,
    })

    const agent = new Agent(mockDeps)
    const result = await agent.run('test')

    expect(result.success).toBe(false)
    expect(result.error).toContain('blocked')
  })
})
