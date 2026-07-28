import pc from 'picocolors'

export function formatMarkdown(text: string): string {
  let result = text

  result = result.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, _lang, code) => {
    return '\n' + pc.dim(code.trim()) + '\n'
  })

  result = result.replace(/^### (.+)$/gm, (_, content) => pc.cyan(pc.bold(content)))
  result = result.replace(/^## (.+)$/gm, (_, content) => pc.cyan(pc.bold(content)))
  result = result.replace(/^# (.+)$/gm, (_, content) => pc.cyan(pc.bold(pc.underline(content))))

  result = result.replace(/`([^`]+)`/g, (_, code) => pc.yellow(code))

  result = result.replace(/\*\*(.+?)\*\*/g, (_, text) => pc.bold(text))

  result = result.replace(/^- (.+)$/gm, (_, item) => ` ${pc.dim('•')} ${item}`)

  return result
}

export function formatError(text: string): string {
  return pc.red(pc.bold('Error: ') + text)
}

export function formatSuccess(text: string): string {
  return pc.green(pc.bold('✓ ') + text)
}

export function formatWarning(text: string): string {
  return pc.yellow(pc.bold('⚠ ') + text)
}
