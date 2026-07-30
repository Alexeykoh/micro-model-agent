import { describe, it, expect } from 'vitest'
import { mcpCallTool } from '../../src/tools/mcp-call'

describe('mcpCallTool', () => {
  it('has correct definition', () => {
    expect(mcpCallTool.name).toBe('mcp_call')
    expect(mcpCallTool.description).toBeTruthy()
    expect(mcpCallTool.parameters.required).toContain('server')
    expect(mcpCallTool.parameters.required).toContain('tool')
    const props = mcpCallTool.parameters.properties as Record<string, any>
    expect(props.server).toBeDefined()
    expect(props.tool).toBeDefined()
    expect(props.args).toBeDefined()
  })

  it('fails when server not found', async () => {
    const result = await mcpCallTool.handler({} as any, {
      server: 'nonexistent-server',
      tool: 'some-tool',
      args: {},
    })
    
    expect(result.success).toBe(false)
    expect(result.output).toContain('not found')
  })

  it('fails when server name is empty', async () => {
    const result = await mcpCallTool.handler({} as any, {
      server: '',
      tool: 'some-tool',
    })
    
    expect(result.success).toBe(false)
  })

  it('fails when tool name is empty', async () => {
    const result = await mcpCallTool.handler({} as any, {
      server: 'some-server',
      tool: '',
    })
    
    expect(result.success).toBe(false)
  })
})
