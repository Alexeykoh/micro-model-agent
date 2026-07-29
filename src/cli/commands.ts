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
    .version('0.3.0')

  program
    .command('init')
    .description('Run interactive setup wizard')
    .action(async () => {
      const answers = await runSetup()
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = bootstrap()
      config.provider.type = answers.provider
      config.provider.baseUrl = answers.apiBase
      config.provider.apiKey = answers.apiKey
      config.model = answers.model
      saveConfig(config, configPath)
      console.log('Configuration saved to ~/.mma/config.json')
    })

  const configCmd = program.command('config').description('Manage configuration')
  configCmd.command('set')
    .argument('<key>', 'Config key (e.g., model, provider.baseUrl)')
    .argument('<value>', 'Config value')
    .description('Set a config value')
    .action((key: string, value: string) => {
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = bootstrap()
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
    .action(() => {
      const { config } = bootstrap()
      console.log(JSON.stringify(config, null, 2))
    })

  const model = program.command('model').description('Manage models')
  model.command('list')
    .description('List available models')
    .action(() => {
      const { config } = bootstrap()
      console.log('Current model:', config.model)
      console.log('(Use /model use <name> to change)')
    })
  model.command('use')
    .argument('<name>', 'Model name')
    .description('Set default model')
    .action((name: string) => {
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = bootstrap()
      config.model = name
      saveConfig(config, configPath)
      console.log(`Model set to: ${name}`)
    })

  const provider = program.command('provider').description('Manage providers')
  provider.command('list')
    .description('List providers')
    .action(() => {
      const { config } = bootstrap()
      console.log('Current provider:', config.provider.type)
      console.log('Base URL:', config.provider.baseUrl)
    })
  provider.command('use')
    .argument('<name>', 'Provider name')
    .description('Set active provider')
    .action((name: string) => {
      const configPath = join(homedir(), '.mma', 'config.json')
      const { config } = bootstrap()
      config.provider.type = name
      saveConfig(config, configPath)
      console.log(`Provider set to: ${name}`)
    })

  program
    .argument('[prompt...]', 'Prompt to execute')
    .description('Run a single prompt')
    .action((prompt: string[]) => {
      /* Handled by main.ts after program.parse() */
    })

  return program
}
