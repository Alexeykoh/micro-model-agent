import { createProgram } from './commands'
import { bootstrap } from '../core/bootstrap'
import { Repl } from './repl'
import { formatMarkdown } from '../ui/md-formatter'
import { runSetup } from './setup'
import { saveConfig } from '../config/config'
import { t } from '../i18n/index'
import pc from 'picocolors'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

async function main(): Promise<void> {
  const program = createProgram()
  program.parse(process.argv)

  const cmdNames = new Set(program.commands.map(c => c.name()))

  const isSubcommand = program.args.length > 0 && cmdNames.has(program.args[0])

  if (isSubcommand) {
    return
  }

  if (program.args.length > 0) {
    const prompt = program.args.join(' ')
    const { agent } = await bootstrap()
    const result = await agent.run(prompt, undefined, (meta) => process.stdout.write(meta))
    if (result.success) {
      console.log(formatMarkdown(result.text))
    } else {
      console.error(`${t('error.prefix')}${result.error}`)
      if (result.text) {
        console.log(formatMarkdown(result.text))
      }
      process.exit(1)
    }
    agent.shutdown()
  } else {
    const configPath = join(homedir(), '.mma', 'config.json')
    if (!existsSync(configPath)) {
      console.log(pc.yellow('\n  ' + t('cli.first_run') + '\n'))
      const answers = await runSetup()
      const { config } = await bootstrap()
      config.provider.type = answers.provider
      config.provider.baseUrl = answers.apiBase
      config.provider.apiKey = answers.apiKey
      config.model = answers.model
      config.contextWindow = answers.contextWindow
      config.maxToolIterations = answers.maxToolIterations
      config.locale = answers.locale
      saveConfig(config, configPath)
    }
    const { agent, config, sessionManager, skillsModule, pluginManager } = await bootstrap()
    const repl = new Repl(agent, config, sessionManager, skillsModule, pluginManager)
    repl.start()
  }
}

main()

export { main }
