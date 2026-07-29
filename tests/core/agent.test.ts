import { describe, it, expect, vi } from 'vitest'
import { Agent } from '../../src/core/agent'
import type { AppConfig } from '../../src/config/types'

function createMockDeps(overrides?: Record<string, unknown>) {
  const mockProvider = {
    model: 'test-model',
    contextWindow: 4096,
    chat: vi.fn().mockReturnValue((async function* () {
      yield { type: 'text' as const, content: 'Hello from mock LLM' }
      yield { type: 'done' as const, finishReason: 'stop' as const }
    })()),
    countTokens: vi.fn().mockReturnValue(10),
  }

  const mockToolExecutor = {
    execute: vi.fn().mockResolvedValue({ success: true, output: 'tool ok' }),
  }

  const mockPluginManager = {
    getAllPlugins: vi.fn().mockReturnValue([]),
    runOnBeforeThink: vi.fn(),
    runOnBeforeTool: vi.fn().mockResolvedValue(true),
    runOnAfterTool: vi.fn(),
    runOnError: vi.fn(),
    runOnSessionStart: vi.fn(),
    runOnSessionEnd: vi.fn(),
  }

  const mockContextManager = {
    addMessage: vi.fn(),
    getMessageCount: vi.fn().mockReturnValue(0),
    needsCompaction: vi.fn().mockReturnValue(false),
    compact: vi.fn(),
    getActiveHistory: vi.fn().mockReturnValue([]),
  }

  const mockHallucinationDetector = {
    validate: vi.fn().mockReturnValue({ status: 'pass' as const }),
  }

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const config: AppConfig = {
    version: '2.0.0',
    model: 'test-model',
    provider: { type: 'openai-compat', baseUrl: 'http://localhost:1234/v1' },
    orchestrator: {},
    contextWindow: 4096,
    contextBudget: { systemPrompt: 0.25, responseReserve: 0.12, compactionThreshold: 0.75 },
    maxToolIterations: 5,
    stuckThreshold: 8,
    autoPlan: true,
    logLevel: 'info',
    locale: 'en',
  }

  return {
    config,
    llmProvider: mockProvider,
    toolExecutor: mockToolExecutor,
    pluginManager: mockPluginManager,
    contextManager: mockContextManager,
    hallucinationDetector: mockHallucinationDetector,
    logger: mockLogger,
    baseDir: '/tmp',
    promptBlocks: [],
    ...overrides,
  }
}

describe('Agent', () => {
  it('returns text response for simple text LLM output', async () => {
    const deps = createMockDeps()
    const agent = new Agent(deps as any)
    const result = await agent.run('hello')
    expect(result.text).toBe('Hello from mock LLM')
    expect(result.success).toBe(true)
  })

  it('executes tool calls and continues loop', async () => {
    const mockProvider = {
      model: 'test-model',
      contextWindow: 4096,
      chat: vi.fn()
        .mockReturnValueOnce((async function* () {
          yield { type: 'tool_call' as const, toolCall: { id: 'call-1', name: 'test_tool', arguments: '{}' } }
          yield { type: 'done' as const, finishReason: 'tool_calls' as const }
        })())
        .mockReturnValueOnce((async function* () {
          yield { type: 'text' as const, content: 'Done after tool' }
          yield { type: 'done' as const, finishReason: 'stop' as const }
        })()),
      countTokens: vi.fn().mockReturnValue(10),
    }

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: 'tool executed', toolCallId: 'call-1' }),
    }

    const deps = createMockDeps({ llmProvider: mockProvider as any, toolExecutor: mockExecutor as any })
    const agent = new Agent(deps as any)
    const result = await agent.run('do something')
    expect(result.text).toBe('Done after tool')
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1)
  })

  it('limits max iterations and returns partial result', async () => {
    const mockProvider = {
      model: 'test-model',
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue((async function* () {
        yield { type: 'tool_call' as const, toolCall: { id: 'call-x', name: 'test_tool', arguments: '{}' } }
        yield { type: 'done' as const, finishReason: 'tool_calls' as const }
      })()),
      countTokens: vi.fn().mockReturnValue(10),
    }

    const mockExecutor = {
      execute: vi.fn().mockResolvedValue({ success: true, output: 'tool ok', toolCallId: 'call-x' }),
    }

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      toolExecutor: mockExecutor as any,
      config: { ...createMockDeps().config, maxToolIterations: 2 },
    })
    const agent = new Agent(deps as any)
    const result = await agent.run('loop forever')
    expect(result.success).toBe(false)
    expect(result.error).toContain('iteration')
  })

  it('hallucination block prevents tool execution', async () => {
    const mockProvider = {
      model: 'test-model',
      contextWindow: 4096,
      chat: vi.fn().mockReturnValue((async function* () {
        yield { type: 'text' as const, content: 'I will delete everything' }
        yield { type: 'done' as const, finishReason: 'stop' as const }
      })()),
      countTokens: vi.fn().mockReturnValue(10),
    }

    const detector = {
      validate: vi.fn().mockReturnValue({ status: 'block' as const, reason: 'Dangerous action detected' }),
    }

    const deps = createMockDeps({
      llmProvider: mockProvider as any,
      hallucinationDetector: detector as any,
    })
    const agent = new Agent(deps as any)
    const result = await agent.run('delete everything')
    expect(result.success).toBe(false)
    expect(result.error).toContain('blocked')
  })
})
