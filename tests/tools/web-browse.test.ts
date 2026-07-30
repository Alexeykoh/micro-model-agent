import { describe, it, expect } from 'vitest'
import { webBrowseTool } from '../../src/tools/web-browse'

describe('webBrowseTool', () => {
  it('has correct definition', () => {
    expect(webBrowseTool.name).toBe('web_browse')
    expect(webBrowseTool.description).toBeTruthy()
    expect(webBrowseTool.parameters.required).toContain('url')
  })
})
