import { describe, it, expect } from 'vitest'
import { TokenCounter } from '../src/llm/token-counter'

describe('TokenCounter', () => {
  it('should count tokens in a string', () => {
    const counter = new TokenCounter()
    const count = counter.count('Hello, world!')
    expect(count).toBeGreaterThan(0)
  })

  it('should return roughly 1 token per word for short text', () => {
    const counter = new TokenCounter()
    const count = counter.count('one two three four five')
    expect(count).toBeGreaterThanOrEqual(3)
    expect(count).toBeLessThanOrEqual(10)
  })

  it('should count tokens increasing with text length', () => {
    const counter = new TokenCounter()
    const short = counter.count('short text')
    const long = counter.count('a much longer text with many more words in it')
    expect(long).toBeGreaterThan(short)
  })

  it('should handle empty string', () => {
    const counter = new TokenCounter()
    expect(counter.count('')).toBe(0)
  })
})
