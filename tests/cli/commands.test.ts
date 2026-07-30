import { describe, it, expect } from 'vitest'
import { createProgram } from '../../src/cli/commands'

describe('CLI commands', () => {
  it('creates program with all commands', () => {
    const program = createProgram()
    expect(program.name()).toBe('mma')
    const cmds = program.commands.map(c => c.name())
    expect(cmds).toContain('init')
    expect(cmds).toContain('config')
    expect(cmds).toContain('model')
    expect(cmds).toContain('provider')
  })

  it('config has set and show subcommands', () => {
    const program = createProgram()
    const config = program.commands.find(c => c.name() === 'config')
    expect(config).toBeDefined()
    const subCmds = config!.commands.map(c => c.name())
    expect(subCmds).toContain('set')
    expect(subCmds).toContain('show')
  })
})
