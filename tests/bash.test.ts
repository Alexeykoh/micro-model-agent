import { describe, it, expect } from 'vitest'
import { bashTool } from '../src/tools/bash'

describe('bash', () => {
  it('should execute a command', async () => {
    const ctx = { baseDir: process.cwd(), config: {}, logger: { info: () => {}, error: () => {} } }
    const result = await bashTool.handler(ctx, { command: 'echo hello' })
    expect(result.success).toBe(true)
    expect(result.output.trim()).toBe('hello')
  })

  it('should handle command failure', async () => {
    const ctx = { baseDir: process.cwd(), config: {}, logger: { info: () => {}, error: () => {} } }
    const result = await bashTool.handler(ctx, { command: 'exit 1' })
    expect(result.success).toBe(false)
  })
})
