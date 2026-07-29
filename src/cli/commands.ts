import { Command } from 'commander'
import { bootstrap } from '../core/bootstrap'
import { saveConfig } from '../config/config'
import { runSetup } from './setup'
import { join } from 'path'
import { homedir } from 'os'

export function createProgram(): Command {
  const program = new Command()
    .name('mma')
    .description('Micro Models Agent — AI coding agent for small models')
    .version('0.4.0')

  program
    .command('init')
    .description('Run interactive setup wizard')
    .action(async () => {
      const answers = await runSetup()
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = await bootstrap()
      config.provider.type = answers.provider
      config.provider.baseUrl = answers.apiBase
      config.provider.apiKey = answers.apiKey
      config.model = answers.model
      config.contextWindow = answers.contextWindow
      config.maxToolIterations = answers.maxToolIterations
      config.locale = answers.locale
      saveConfig(config, configPath)
      console.log('Configuration saved to ~/.mma/config.json')
    })

  const configCmd = program.command('config').description('Manage configuration')
  configCmd.command('set')
    .argument('<key>', 'Config key (e.g., model, provider.baseUrl)')
    .argument('<value>', 'Config value')
    .description('Set a config value')
    .action(async (key: string, value: string) => {
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = await bootstrap()
      const keys = key.split('.')
      let obj: any = config
      for (let i = 0; i < keys.length - 1; i++) {
        if (!(keys[i] in obj)) obj[keys[i]] = {}
        obj = obj[keys[i]]
      }
      const lastKey = keys[keys.length - 1]
      if (value === 'true') obj[lastKey] = true
      else if (value === 'false') obj[lastKey] = false
      else if (/^\d+$/.test(value)) obj[lastKey] = parseInt(value, 10)
      else if (/^\d+\.\d+$/.test(value)) obj[lastKey] = parseFloat(value)
      else obj[lastKey] = value
      saveConfig(config, configPath)
      console.log(`Set ${key}=${value}`)
    })
  configCmd.command('show')
    .description('Show current config')
    .action(async () => {
      const { config } = await bootstrap()
      console.log(JSON.stringify(config, null, 2))
    })

  const model = program.command('model').description('Manage models')
  model.command('list')
    .description('List available models')
    .action(async () => {
      const { config } = await bootstrap()
      console.log('Current model:', config.model)
      console.log('(Use /model use <name> to change)')
    })
  model.command('use')
    .argument('<name>', 'Model name')
    .description('Set default model')
    .action(async (name: string) => {
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = await bootstrap()
      config.model = name
      saveConfig(config, configPath)
      console.log(`Model set to: ${name}`)
    })

  const provider = program.command('provider').description('Manage providers')
  provider.command('list')
    .description('List providers')
    .action(async () => {
      const { config } = await bootstrap()
      console.log('Current provider:', config.provider.type)
      console.log('Base URL:', config.provider.baseUrl)
    })
  provider.command('use')
    .argument('<name>', 'Provider name')
    .description('Set active provider')
    .action(async (name: string) => {
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = await bootstrap()
      config.provider.type = name
      saveConfig(config, configPath)
      console.log(`Provider set to: ${name}`)
    })

  const session = program.command('session').description('Manage sessions')
  session.command('list')
    .description('List all sessions')
    .action(async () => {
      const { sessionManager } = await bootstrap()
      const sessions = sessionManager.list()
      if (sessions.length === 0) {
        console.log('No sessions found')
        return
      }
      const active = sessionManager.getActive()
      for (const s of sessions) {
        const marker = s.id === active ? '*' : ' '
        console.log(` ${marker} ${s.id.slice(0, 12)}  ${s.name}  ${s.messageCount} msgs  ${s.updatedAt.slice(0, 10)}`)
      }
    })
  session.command('show')
    .argument('<id>', 'Session id')
    .description('Show session details')
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap()
      const meta = sessionManager.get(id)
      if (!meta) {
        console.log(`Session not found: ${id}`)
        return
      }
      console.log(`ID:           ${meta.id}`)
      console.log(`Name:         ${meta.name}`)
      console.log(`Created:      ${meta.createdAt}`)
      console.log(`Updated:      ${meta.updatedAt}`)
      console.log(`Messages:     ${meta.messageCount}`)
      console.log(`Model:        ${meta.model}`)
      console.log(`Context:      ${meta.contextWindow}`)
      console.log(`Project:      ${meta.projectDir}`)
    })
  session.command('delete')
    .argument('<id>', 'Session id')
    .description('Delete a session')
    .action(async (id: string) => {
      const { sessionManager } = await bootstrap()
      sessionManager.delete(id)
      console.log(`Session deleted: ${id}`)
    })

  program
    .argument('[prompt...]', 'Prompt to execute')
    .description('Run a single prompt')
    .action((prompt: string[]) => {
      /* Handled by main.ts after program.parse() */
    })

  return program
}
