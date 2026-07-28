import { getEncoding } from 'js-tiktoken'

export class TokenCounter {
  private encoder: ReturnType<typeof getEncoding>

  constructor(model?: string) {
    this.encoder = getEncoding('cl100k_base')
  }

  count(text: string): number {
    if (!text) return 0
    return this.encoder.encode(text).length
  }

  countTokens(text: string): number {
    return this.count(text)
  }
}
