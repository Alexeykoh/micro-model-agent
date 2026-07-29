import { createProgram } from './commands'
import { bootstrap } from '../core/bootstrap'
import { Repl } from './repl'
import { formatMarkdown } from '../ui/md-formatter'

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
    const result = await agent.run(prompt)
    if (result.success) {
      console.log(formatMarkdown(result.text))
    } else {
      console.error(`Error: ${result.error}`)
      if (result.text) {
        console.log(formatMarkdown(result.text))
      }
      process.exit(1)
    }
    agent.shutdown()
  } else {
    const { agent, config, sessionManager, skillsModule } = await bootstrap()
    const repl = new Repl(agent, config, sessionManager, skillsModule)
    repl.start()
  }
}

main()

export { main }
