import { Command } from 'commander'

export function createProgram(): Command {
  const program = new Command()
    .name('