import { describe, it, expect } from 'vitest'
import { PipelineParser } from '../src/modules/pipelines/parser'

describe('PipelineParser', () => {
  it('should parse a valid pipeline YAML', () => {
    const yaml = `
name: implement-feature
steps:
  - id: research
    agent: explore
    prompt: "Research {feature}"
  - id: implement
    agent: code
    depends_on: [research]
    prompt: "Implement based on {{steps.research.output}}"
`
    const pipeline = PipelineParser.parse(yaml)
    expect(pipeline.name).toBe('implement-feature')
    expect(pipeline.steps).toHaveLength(2)
    expect(pipeline.steps[0].id).toBe('research')
    expect(pipeline.steps[1].depends_on).toEqual(['research'])
  })

  it('should handle parallel steps', () => {
    const yaml = `
name: parallel
steps:
  - id: a
    agent: code
    prompt: "A"
  - id: b
    agent: code
    parallel: true
    prompt: "B"
    depends_on: [a]
  - id: c
    agent: code
    parallel: true
    prompt: "C"
    depends_on: [a]
`
    const pipeline = PipelineParser.parse(yaml)
    const stepB = pipeline.steps.find(s => s.id === 'b')
    expect(stepB?.parallel).toBe(true)
  })

  it('should validate missing fields', () => {
    expect(() => PipelineParser.parse('name: invalid')).toThrow()
  })
})
