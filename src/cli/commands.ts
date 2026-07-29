import { Command } from 'commander'

export function createProgram(): Command {
  const program = new Command()
    .name('mma')
    .description('Micro Models Agent — AI coding agent for small models')
    .version('0.3.0')

  program
    .command('init')
    .description('Run interactive setup wizard')
    .action(() => {
      console.log('Running setup wizard...')
    })

  const config = program.command('config').description('Manage configuration')
  config.command('set')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .description('Set a config value')
    .action((key: string, value: string) => {
      console.log(`Setting ${key}=${value}`)
    })
  config.command('show')
    .description('Show current config')
    .action(() => {
      console.log('Showing config...')
    })

  const model = program.command('model').description('Manage models')
  model.command('list')
    .description('List available models')
    .action(() => console.log('Listing models...'))
  model.command('use')
    .argument('<name>', 'Model name')
    .description('Set default model')
    .action((name: string) => console.log(`Using model: ${name}`))

  const provider = program.command('provider').description('Manage providers')
  provider.command('list')
    .description('List providers')
    .action(() => console.log('Listing providers...'))
  provider.command('use')
    .argument('<name>', 'Provider name')
    .description('Set active provider')
    .action((name: string) => console.log(`Using provider: ${name}`))

  program
    .argument('[prompt...]', 'Prompt to execute')
    .description('Run a single prompt')
    .action((prompt: string[]) => {
      if (prompt.length > 0) {
        console.log(`Running: ${prompt.join(' ')}`)
      }
    })

  return program
}
