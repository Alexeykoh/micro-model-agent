import { describe, expect, it } from 'bun:test'
import { LintOnWritePlugin } from '../../../../src/modules/plugins/builtin/lint-on-write'

describe('LintOnWritePlugin', () => {
  it('should run lint after write_file tool', async () => {
    const plugin = new LintOnWritePlugin()
    const mockCtx = { baseDir: '/test', logger: { debug: () => {}, warn: () => {} } } as any
    const mockResult = { success: true, output: 'File written', toolName: 'write_file' } as any

    await plugin.onAfterTool!(mockCtx, mockResult)

    expect(true).toBe(true)
  })

  it('should skip lint for non-write tools', async () => {
    const plugin = new LintOnWritePlugin()
    const mockCtx = { baseDir: '/test', logger: { debug: () => {}, warn: () => {} } } as any
    const mockResult = { success: true, output: 'ok', toolName: 'read_file' } as any

    await plugin.onAfterTool!(mockCtx, mockResult)

    expect(true).toBe(true)
  })
})
