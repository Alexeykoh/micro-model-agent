import type { PromptBlock } from './types'

export interface BuildResult {
  prompt: string
  excluded: string[]
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export class PromptBuilder {
  private blocks: PromptBlock[] = []
  private budget: number

  constructor(budget: number) {
    this.budget = budget
  }

  addBlock(block: PromptBlock): void {
    this.blocks.push(block)
  }

  addBlocks(blocks: PromptBlock[]): void {
    for (const b of blocks) {
      this.blocks.push(b)
    }
  }

  build(): BuildResult {
    const essential: PromptBlock[] = []
    const nonEssential: PromptBlock[] = []

    for (const block of this.blocks) {
      if (block.essential) {
        essential.push(block)
      } else {
        nonEssential.push(block)
      }
    }

    nonEssential.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    )

    let usedTokens = 0
    const included: string[] = []
    const excluded: string[] = []

    for (const block of [...essential, ...nonEssential]) {
      const tokens = block.estimatedTokens
      if (usedTokens + tokens <= this.budget) {
        included.push(block.content)
        usedTokens += tokens
      } else if (!block.essential) {
        excluded.push(block.content)
      }
    }

    return {
      prompt: included.join('\n\n'),
      excluded,
    }
  }
}
