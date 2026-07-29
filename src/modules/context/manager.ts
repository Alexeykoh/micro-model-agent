export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

export interface ContextBudget {
  systemPrompt: number
  responseReserve: number
  history: number
}

const COMPACTION_INTERVAL = 15
const KEEP_LAST_N = 6

export class ContextManager {
  private contextWindow: number
  private messages: Message[] = []
  private compactedBlock: string | null = null
  private iterationsSinceCompaction = 0
  private budget: ContextBudget
  onCompact: ((messages: Message[]) => void) | null = null

  constructor(contextWindow: number) {
    this.contextWindow = contextWindow
    this.budget = this.calculateBudget(contextWindow)
  }

  private calculateBudget(window: number): ContextBudget {
    return {
      systemPrompt: Math.floor(window * 0.25),
      responseReserve: Math.floor(window * 0.12),
      history: Math.floor(window * 0.63),
    }
  }

  getBudget(): ContextBudget {
    return { ...this.budget }
  }

  addMessage(msg: Message): void {
    this.messages.push(msg)
    this.iterationsSinceCompaction++
  }

  getMessageCount(): number {
    return this.messages.length
  }

  needsCompaction(): boolean {
    if (this.iterationsSinceCompaction >= COMPACTION_INTERVAL) return true
    const totalTokens = this.messages.reduce((sum, m) => sum + m.content.length / 2, 0)
    return totalTokens > this.budget.history * 0.75
  }

  compact(): void {
    if (this.messages.length <= KEEP_LAST_N * 2) return

    if (this.onCompact) {
      this.onCompact(this.messages)
    }

    const cutoff = this.messages.length - KEEP_LAST_N * 2
    const oldTurns = this.messages.slice(0, cutoff)
    const recentTurns = this.messages.slice(cutoff)

    const facts: string[] = []
    const decisions: string[] = []
    const errors: string[] = []

    for (const msg of oldTurns) {
      if (msg.content.includes('[fact]') || msg.role === 'tool') {
        facts.push(msg.content.slice(0, 200))
      }
      if (msg.content.includes('decided') || msg.content.includes('decision:')) {
        decisions.push(msg.content.slice(0, 200))
      }
      if (msg.content.includes('Error:') || msg.content.includes('failed')) {
        errors.push(msg.content.slice(0, 300))
      }
    }

    const compactedParts: string[] = []
    if (facts.length > 0) compactedParts.push(`[Facts: ${facts.slice(-10).join('; ')}]`)
    if (decisions.length > 0) compactedParts.push(`[Decisions: ${decisions.slice(-5).join('; ')}]`)
    if (errors.length > 0) compactedParts.push(`[Errors: ${errors.slice(-3).join('; ')}]`)

    if (compactedParts.length > 0 || oldTurns.length > 0) {
      this.compactedBlock = `[Compressed: ${oldTurns.length} turns, ${facts.length} facts] ` + compactedParts.join(' ')
    }

    this.messages = [
      { role: 'system', content: this.compactedBlock || '' },
      ...recentTurns,
    ]
    this.iterationsSinceCompaction = 0
  }

  getActiveHistory(): Message[] {
    return [...this.messages]
  }

  clear(): void {
    this.messages = []
    this.compactedBlock = null
    this.iterationsSinceCompaction = 0
  }

  getEstimatedTokens(): number {
    return this.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 2), 0)
  }
}
