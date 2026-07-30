import { describe, it, expect } from 'vitest'
import { webSearchTool } from '../../src/tools/web-search'

describe('webSearchTool', () => {
  it('has correct definition', () => {
    expect(webSearchTool.name).toBe('web_search')
    expect(webSearchTool.description).toBeTruthy()
    expect(webSearchTool.parameters.required).toContain('query')
  })
})
