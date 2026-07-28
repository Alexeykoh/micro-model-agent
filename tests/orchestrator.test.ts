import { describe, it, expect, vi } from 'vitest'
import { OrchestratorClient } from '../src/llm/orchestrator'

describe('OrchestratorClient', () => {
  it('should check if orchestrator is enabled', () => {
    const client = new OrchestratorClient({
      model: 'gpt-4o',
      provider: {
        type: 'openai-compat',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      },
    })
    expect(client.isEnabled()).toBe(true)
  })

  it('should be disabled when no model configured', () => {
    const client = new OrchestratorClient({})
    expect(client.isEnabled()).toBe(false)
  })

  it('should use same provider when no explicit provider given', () => {
    const client = new OrchestratorClient({
      model: 'qwen3-70b',
    })
    expect(client.isEnabled()).toBe(true)
  })

  it('should create plan via orchestrator', async () => {
    const client = new OrchestratorClient({
      model: 'gpt-4o',
      provider: {
        type: 'openai-compat',
        baseUrl: 'http://localhost:1234/v1',
      },
    })

    const mockChat = vi.fn()
    const mockChunks: any[] = [
      { type: 'text', content: '{"steps": ["step1", "step2"]}' },
      { type: 'done', finishReason: 'stop' },
    ]
    mockChat.mockReturnValue(
      (async function* () {
        for (const c of mockChunks) yield c
      })()
    )

    ;(client as any).provider = { chat: mockChat }

    const plan = await client.createPlan('Implement OAuth')
    expect(plan).toBeDefined()
    expect(mockChat).toHaveBeenCalled()
  })

  it('should throw when disabled and asked to plan', async () => {
    const client = new OrchestratorClient({})
    await expect(client.createPlan('test')).rejects.toThrow('not enabled')
  })
})
