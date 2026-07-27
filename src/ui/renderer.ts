/**
 * Интерфейс рендерера вывода.
 *
 * Определяет контракт для readline-рендерера:
 * - Вывод текста (write, writeLine, writeError)
 * - Вывод инструментов (writeToolHeader, writeToolResult)
 * - Streaming markdown (writeMarkdownChunk)
 * - Спиннер (writeSpinner)
 * - Статус-бар (updateContextUsage, updateStatus)
 * - Ввод (prompt, promptWithChoices)
 * - Прерывание (abort, abortSignal)
 *
 * @module ui/renderer
 */

/** Информация о статусе для отображения в status bar */
export interface StatusInfo {
  provider?: string
  model?: string
  tokens?: number
  contextWindow?: number
  step?: number
  maxSteps?: number
}

/** Интерфейс readline-рендерера */
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
  writeToolBuffer?(data: { lines: string[]; toolCalls: { name: string; args: string; result: string }[] }): void

  writeMarkdownChunk(chunk: string): void
  commitMarkdown(): void
  setStreamRole?(role: 'assistant' | 'subagent' | 'expert' | null): void

  writeSpinner(text?: string): void
  clearSpinner(): void

  updateContextUsage(text: string): void
  updateStatus(info: StatusInfo): void

  clear(): void
  undoLastMessage(): void

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
