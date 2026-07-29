import { describe, expect, it } from 'bun:test'
import { ProviderArgProvider } from '../../src/cli/completer'

describe('ProviderArgProvider', () => {
  it('should complete provider names', () => {
    const provider = new ProviderArgProvider(['openai-compat', 'ollama', 'vllm'])
    const ctx = {
      line: '/provider use ',
      cursor: 14,
      tokens: ['/provider', 'use', ''],
      partial: '',
      tokenIndex: 2,
    }

    const matches = provider.complete(ctx)

    expect(matches).toContain('openai-compat')
    expect(matches).toContain('ollama')
    expect(matches).toContain('vllm')
  })
})
