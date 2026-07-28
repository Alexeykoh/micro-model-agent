import { describe, it, expect, beforeEach } from 'vitest'
import { ToolRegistry } from '../src/tools/registry'
import type { ToolDefinition } from '../src/tools/types'

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('should register and retrieve a tool', () => {
    const tool: ToolDefinition = {
      name: 'test_tool',
      description: 'A test tool',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: 'done' }),
    }
    registry.register(tool)
    expect(registry.get('test_tool')).toBe(tool)
  })

  it('should throw on duplicate registration', () => {
    const tool: ToolDefinition = {
      name: 'dup',
      description: 'dup',
      parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    }
    registry.register(tool)
    expect(() => registry.register(tool)).toThrow(/dup/)
  })

  it('should list all tool names', () => {
    registry.register({
      name: 'a', description: 'a', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    registry.register({
      name: 'b', description: 'b', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    expect(registry.list()).toEqual(['a', 'b'])
  })

  it('should return all tool definitions', () => {
    registry.register({
      name: 'x', description: 'x desc', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    const defs = registry.getAll()
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('x')
  })

  it('should check if tool exists', () => {
    expect(registry.has('nonexistent')).toBe(false)
    registry.register({
      name: 'exists', description: '', parameters: { type: 'object', properties: {} },
      handler: async () => ({ success: true, output: '' }),
    })
    expect(registry.has('exists')).toBe(true)
  })
})
