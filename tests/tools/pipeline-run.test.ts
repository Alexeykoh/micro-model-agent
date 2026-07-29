import { describe, it, expect } from 'vitest'
import { pipelineRunTool } from '../../src/tools/pipeline-run'

describe('pipelineRunTool', () => {
  it('has correct definition', () => {
    expect(pipelineRunTool.name).toBe('pipeline_run')
    expect(pipelineRunTool.description).toBeTruthy()
    expect(pipelineRunTool.parameters.required).toContain('name')
    expect(pipelineRunTool.parameters.required).toContain('yaml')
    const props = pipelineRunTool.parameters.properties as Record<string, any>
    expect(props.name).toBeDefined()
    expect(props.yaml).toBeDefined()
  })

  it('parses valid pipeline YAML', async () => {
    const yaml = `
name: test-pipeline
steps:
  - id: step1
    agent: default
    prompt: Do something
  - id: step2
    agent: default
    prompt: Do another thing
    depends_on:
      - step1
`
    const result = await pipelineRunTool.handler({} as any, {
      name: 'test-pipeline',
      yaml,
    })
    
    expect(result.success).toBe(true)
    expect(result.output).toContain('test-pipeline')
    expect(result.output).toContain('Steps: 2')
    expect(result.output).toContain('step1')
    expect(result.output).toContain('step2')
  })

  it('fails on invalid YAML', async () => {
    const result = await pipelineRunTool.handler({} as any, {
      name: 'bad-pipeline',
      yaml: 'invalid: yaml',
    })
    
    expect(result.success).toBe(false)
    expect(result.output).toContain('error')
  })

  it('fails on empty YAML', async () => {
    const result = await pipelineRunTool.handler({} as any, {
      name: 'empty',
      yaml: '',
    })
    
    expect(result.success).toBe(false)
  })
})
