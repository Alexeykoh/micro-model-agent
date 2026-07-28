import { OpenAICompatProvider } from './openai-compat'
import type { LLMProvider, Message } from './provider'

export interface OrchestratorConfig {
  model?: string
  provider?: {
    type?: string
    baseUrl?: string
    apiKey?: string
  }
}

export class OrchestratorClient {
  private config: OrchestratorConfig
  private provider: LLMProvider | null = null

  constructor(config: OrchestratorConfig, defaultProvider?: LLMProvider) {
    this.config = config
    if (config.model) {
      if (config.provider) {
        this.provider = new OpenAICompatProvider({
          model: config.model,
          baseUrl: config.provider.baseUrl || 'http://localhost:1234/v1',
          apiKey: config.provider.apiKey,
        })
      } else if (defaultProvider) {
        this.provider = defaultProvider
      } else {
        this.provider = new OpenAICompatProvider({
          model: config.model,
          baseUrl: 'http://localhost:1234/v1',
        })
      }
    }
  }

  isEnabled(): boolean {
    return this.provider !== null
  }

  async createPlan(task: string): Promise<{ steps: string[] }> {
    if (!this.provider) throw new Error('Orchestrator not enabled')

    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a planning assistant. Break down tasks into steps. Respond with JSON only: {"steps": ["step 1", "step 2", ...]}',
      },
      { role: 'user', content: task },
    ]

    const chunks: any[] = []
    for await (const chunk of this.provider.chat(messages)) {
      chunks.push(chunk)
    }

    const text = chunks
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.content)
      .join('')

    try {
      return JSON.parse(text)
    } catch {
      return { steps: [task] }
    }
  }

  async resolveConflict(context: string): Promise<string> {
    if (!this.provider) throw new Error('Orchestrator not enabled')

    const messages: Message[] = [
      {
        role: 'system',
        content: 'You are a conflict resolution assistant. Analyze the situation and recommend the best path forward.',
      },
      { role: 'user', content: context },
    ]

    let result = ''
    for await (const chunk of this.provider.chat(messages)) {
      if (chunk.type === 'text' && chunk.content) result += chunk.content
    }

    return result
  }
}
