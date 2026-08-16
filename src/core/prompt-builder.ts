import type { PromptBlock } from './types'

export interface BlockBuildInfo {
  label: string
  priority: string
  essential: boolean
  tokens: number
  included: boolean
}

export interface BuildResult {
  prompt: string
  excluded: string[]
  /** Per-block breakdown — used to log what the system prompt actually consists of. */
  blocks: BlockBuildInfo[]
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
}

function blockLabel(content: string): string {
  const firstLine = content.split("\n")[0].trim()
  return firstLine.length > 70 ? firstLine.slice(0, 67) + "..." : firstLine
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
    const blocks: BlockBuildInfo[] = []

    for (const block of essential) {
      included.push(block.content)
      usedTokens += block.estimatedTokens
      blocks.push({
        label: blockLabel(block.content),
        priority: block.priority,
        essential: true,
        tokens: block.estimatedTokens,
        included: true,
      })
    }

    for (const block of nonEssential) {
      const tokens = block.estimatedTokens
      const fits = usedTokens + tokens <= this.budget
      if (fits) {
        included.push(block.content)
        usedTokens += tokens
      } else {
        excluded.push(block.content)
      }
      blocks.push({
        label: blockLabel(block.content),
        priority: block.priority,
        essential: false,
        tokens,
        included: fits,
      })
    }

    return {
      prompt: included.join('\n\n'),
      excluded,
      blocks,
    }
  }
}
