import type { LLMProvider, Message, Chunk, ToolDefinition } from './provider'
import { TokenCounter } from './token-counter'

export interface OpenAICompatConfig {
  model: string
  baseUrl: string
  apiKey?: string
  contextWindow?: number
}

export class OpenAICompatProvider implements LLMProvider {
  readonly model: string
  readonly contextWindow: number
  private config: OpenAICompatConfig
  private tokenCounter: TokenCounter

  constructor(config: OpenAICompatConfig) {
    this.config = config
    this.model = config.model
    this.contextWindow = config.contextWindow ?? 32768
    this.tokenCounter = new TokenCounter()
  }

  async *chat(
    messages: Message[],
    tools?: ToolDefinition[]
  ): AsyncIterable<Chunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey && this.config.apiKey !== 'not-needed') {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`LLM API error ${response.status} (${response.statusText}): ${errorText}`)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('No response body stream')

    const decoder = new TextDecoder()
    let buffer = ''
    let toolCallAccumulator: { id?: string; name?: string; arguments?: string } = {}

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            yield { type: 'done', finishReason: 'stop' }
            continue
          }

          try {
            const parsed = JSON.parse(data)
            const choice = parsed.choices?.[0]
            if (!choice) continue

            const delta = choice.delta || {}
            const finishReason = choice.finish_reason

            if (delta.reasoning_content) {
              yield { type: 'reasoning', content: delta.reasoning_content }
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) toolCallAccumulator.id = tc.id
                if (tc.function?.name) toolCallAccumulator.name = tc.function.name
                if (tc.function?.arguments) {
                  toolCallAccumulator.arguments = (toolCallAccumulator.arguments || '') + tc.function.arguments
                }
              }
            }

            if (delta.content) {
              yield { type: 'text', content: delta.content }
            }

            if (finishReason === 'tool_calls' && toolCallAccumulator.name) {
              yield {
                type: 'tool_call',
                toolCall: {
                  id: toolCallAccumulator.id || '',
                  name: toolCallAccumulator.name,
                  arguments: toolCallAccumulator.arguments || '{}',
                },
              }
              toolCallAccumulator = {}
            }

            if (finishReason === 'stop') {
              yield { type: 'done', finishReason: 'stop' }
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  countTokens(text: string): number {
    return this.tokenCounter.count(text)
  }
}
