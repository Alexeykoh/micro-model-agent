import { createProgram } from './commands'

function main(): void {
  const program = createProgram()
  program.parse(process.argv)

  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('Starting REPL...')
  }
}

main()

export { main }
