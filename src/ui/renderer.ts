export interface StatusInfo {
  provider?: string
  model?: string
  tokens?: number
  contextWindow?: number
  step?: number
  maxSteps?: number
}

export interface OutputRenderer {
  write(text: string): void
  writeLine(text?: string): void
  writeNewline(): void

  writeInfo(text: string): void
  writeSuccess(text: string): void
  writeWarning(text: string): void
  writeError(text: string): void
  writeDim(text: string): void
  writeBracketTag(tag: string, message: string): void
  writeHeading(text: string): void

  writeToolHeader(name: string): void
  writeToolPreview(toolName: string, argsJson: string): void
  writeToolResult(time: string, exitCode?: number, result?: string): void

  writeMarkdownChunk(chunk: string): void
  commitMarkdown(): void

  writeSpinner(text?: string): void
  clearSpinner(): void

  updateContextUsage(text: string): void
  updateStatus(info: StatusInfo): void

  clear(): void

  prompt(msg: string): Promise<string>
  promptWithChoices?(msg: string, choices: string[]): Promise<string>

  writeFileOutput(lines: string[], startIndex?: number): void

  setMode?(mode: string): void

  start(): Promise<void>
  destroy(): void

  readonly abortSignal?: AbortSignal
  abort?(): void
  resetAbort?(): void
}
