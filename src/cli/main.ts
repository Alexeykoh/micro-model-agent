import { createProgram } from './commands'
import { bootstrap } from '../core/bootstrap'
import { Repl } from './repl'

async function main(): Promise<void> {
  const program = createProgram()
  program.parse(process.argv)

  const args = program.args

  if (args.length > 0) {
    const prompt = args.join(' ')
    const { agent, logger } = bootstrap()
    const result = await agent.run(prompt)
    if (result.success) {
      console.log(result.text)
    } else {
      console.error(`Error: ${result.error}`)
      if (result.text) {
        console.log(`Partial output:\n${result.text}`)
      }
      process.exit(1)
    }
  } else {
    const { agent, config } = bootstrap()
    const repl = new Repl(agent, config)
    repl.start()
  }
}

main()

export { main }
