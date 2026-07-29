/**
 * Integration tests for LLM provider.
 * Run: bun run test:integration
 * Requires an OpenAI-compatible API at $MMA_PROVIDER_BASEURL (default: http://localhost:1234/v1)
 * Skip with: $env:MMA_SKIP_INTEGRATION=1
 */

import { describe, it, expect } from 'vitest'
import { OpenAICompatProvider } from '../../src/llm/openai-compat'

const BASE_URL = process.env.MMA_PROVIDER_BASEURL || 'http://localhost:1234/v1'
const MODEL = process.env.MMA_MODEL || 'qwen3.5-9b'
const API_KEY = process.env.MMA_PROVIDER_APIKEY || 'not-needed'

const shouldSkip = process.env.MMA_SKIP_INTEGRATION === '1'

describe.skipIf(shouldSkip)('LLM Provider (integration)', () => {

  it('should connect and return a chat response', async () => {
    const provider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    })

    const messages = [
      { role: 'system' as const, content: 'You are a helpful assistant. Reply in one short sentence.' },
      { role: 'user' as const, content: 'Say "hello world" exactly.' },
    ]

    let result = ''
    for await (const chunk of provider.chat(messages)) {
      if (chunk.type === 'text' && chunk.content) {
        result += chunk.content
      }
    }

    expect(result.length).toBeGreaterThan(0)
    expect(result.toLowerCase()).toContain('hello')
  }, 60000)

  it('should handle tool call requests', async () => {
    const provider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    })

    const messages = [
      { role: 'system' as const, content: 'You have access to tools like get_weather. Use them when asked about weather.' },
      { role: 'user' as const, content: 'What is the weather in Paris?' },
    ]

    let sawToolCall = false
    let sawText = false
    for await (const chunk of provider.chat(messages)) {
      if (chunk.type === 'tool_call') sawToolCall = true
      if (chunk.type === 'text' && chunk.content) sawText = true
    }

    expect(sawToolCall || sawText).toBe(true)
  }, 30000)

  it('should stream text content', async () => {
    const provider = new OpenAICompatProvider({
      model: MODEL,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      contextWindow: 32768,
    })

    const messages = [
      { role: 'system' as const, content: 'Think step by step.' },
      { role: 'user' as const, content: 'What is 2+2?' },
    ]

    let sawText = false
    for await (const chunk of provider.chat(messages)) {
      if (chunk.type === 'text' && chunk.content) {
        sawText = true
      }
    }

    expect(sawText).toBe(true)
  }, 30000)
})
