import * as readline from 'readline'
import { Completer } from './completer'
import { SlashCommandProvider } from './completer'

interface SlashCommand {
  name: string
  description: string
  aliases?: string[]
  action(args: string[]): void | Promise<void>
}

export class Repl {
  private rl: readline.Interface
  private commands: Map<string, SlashCommand> = new Map()
  private completer: Completer = new Completer()
  private running = false

  constructor() {
    this.rl = readline.createInterface({
      input: process