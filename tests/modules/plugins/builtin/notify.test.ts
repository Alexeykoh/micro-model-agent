import { describe, expect, it } from 'bun:test'
import { NotifyPlugin } from '../../../../src/modules/plugins/builtin/notify'

describe('NotifyPlugin', () => {
  it('should log notification on session end', () => {
    const plugin = new NotifyPlugin()
    const logs: string[] = []
    const mockCtx = { logger: { info: (msg: string) => logs.push(msg) } } as any

    plugin.onSessionEnd!(mockCtx)

    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]).toContain('Session ended')
  })
})
