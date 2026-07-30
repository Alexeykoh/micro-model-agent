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

  it('should filter tools by tags', () => {
    registry.register({
      name: 'read_file', description: '', parameters: { type: 'object', properties: {} },
      tags: ['file', 'code'], handler: async () => ({ success: true, output: '' }),
    })
    registry.register({
      name: 'bash', description: '', parameters: { type: 'object', properties: {} },
      tags: ['shell'], handler: async () => ({ success: true, output: '' }),
    })
    registry.register({
      name: 'browser', description: '', parameters: { type: 'object', properties: {} },
      tags: ['browser', 'vision'], handler: async () => ({ success: true, output: '' }),
    })

    const fileTools = registry.getByTags(['file'])
    expect(fileTools).toHaveLength(1)
    expect(fileTools[0].name).toBe('read_file')

    const codeShellTools = registry.getByTags(['code', 'shell'])
    expect(codeShellTools).toHaveLength(2)
    expect(codeShellTools.map(t => t.name).sort()).toEqual(['bash', 'read_file'])

    const browserVision = registry.getByTags(['browser', 'vision'])
    expect(browserVision).toHaveLength(1)
    expect(browserVision[0].name).toBe('browser')
  })

  it('should return LLM-safe tool definitions filtered by tags', () => {
    registry.register({
      name: 'write_file', description: 'Writes files', parameters: { type: 'object', properties: {} },
      tags: ['file'], handler: async () => ({ success: true, output: '' }),
    })

    const all = registry.getAllForLLM()
    expect(all.some(t => t.name === 'write_file')).toBe(true)
    expect(all[0]).not.toHaveProperty('handler')
    expect(all[0]).not.toHaveProperty('tags')

    const filtered = registry.getAllForLLM(['shell'])
    expect(filtered.some(t => t.name === 'write_file')).toBe(false)
  })
})
