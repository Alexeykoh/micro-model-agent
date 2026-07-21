import type { OutputRenderer, StatusInfo } from './renderer.js';

/**
 * Буферизированный рендерер для субагентов.
 *
 * Перехватывает весь вывод субагента (streaming, tool calls, сообщения)
 * и сохраняет его в буфер вместо отправки в основной UI.
 * Родительский компонент может прочитать буфер для отображения
 * прогресса субагента в его ToolCallBlock.
 *
 * @module ui/subagent-renderer
 */

export interface SubagentBuffer {
  lines: string[];
  toolCalls: { name: string; args: string; result: string }[];
  streaming: string;
}

export class SubagentRenderer implements OutputRenderer {
  private buffer: SubagentBuffer = { lines: [], toolCalls: [], streaming: '' };
  private _abortController = new AbortController();

  get abortSignal(): AbortSignal {
    return this._abortController.signal;
  }

  getBuffer(): SubagentBuffer {
    return this.buffer;
  }

  clearBuffer(): void {
    this.buffer = { lines: [], toolCalls: [], streaming: '' };
  }

  // ── Текст ──
  write(text: string): void {
    this.buffer.lines.push(text);
  }
  writeLine(text?: string): void {
    this.buffer.lines.push(text ?? '');
  }
  writeNewline(): void {
    this.buffer.lines.push('');
  }

  // ── Стилизованный вывод ──
  writeInfo(text: string): void {
    this.buffer.lines.push(text);
  }
  writeSuccess(text: string): void {
    this.buffer.lines.push(text);
  }
  writeWarning(text: string): void {
    this.buffer.lines.push(text);
  }
  writeError(text: string): void {
    this.buffer.lines.push(text);
  }
  writeDim(text: string): void {
    this.buffer.lines.push(text);
  }
  writeBracketTag(tag: string, message: string): void {
    this.buffer.lines.push(`[${tag}] ${message}`);
  }
  writeHeading(text: string): void {
    this.buffer.lines.push(text);
  }

  // ── Tool calls ──
  writeToolHeader(name: string): void {
    this.buffer.toolCalls.push({ name, args: '', result: '' });
  }
  writeToolPreview(_toolName: string, argsJson: string): void {
    const last = this.buffer.toolCalls[this.buffer.toolCalls.length - 1];
    if (last) last.args = argsJson;
  }
  writeToolResult(time: string, exitCode?: number, result?: string): void {
    const last = this.buffer.toolCalls[this.buffer.toolCalls.length - 1];
    if (last) {
      last.result = result ?? '';
      this.buffer.lines.push(`[${last.name}] ${exitCode === 0 ? 'ok' : `exit ${exitCode}`} (${time}s)`);
    }
  }

  // ── Streaming ──
  writeMarkdownChunk(chunk: string): void {
    this.buffer.streaming += chunk;
  }
  commitMarkdown(): void {
    if (this.buffer.streaming) {
      this.buffer.lines.push(this.buffer.streaming);
      this.buffer.streaming = '';
    }
  }

  // ── Спиннер (не показываем в буфере) ──
  writeSpinner(_text?: string): void { }
  clearSpinner(): void { }

  // ── Статус (игнорируем) ──
  updateContextUsage(_text: string): void { }
  updateStatus(_info: StatusInfo): void { }

  clear(): void {
    this.clearBuffer();
  }

  undoLastMessage(): void {
    // subagent buffer — no-op, streaming content is internal
  }

  // ── Ввод (не используется в субагентах) ──
  async prompt(_msg: string): Promise<string> { return ''; }
  async promptWithChoices(_msg: string, _choices: string[]): Promise<string> { return ''; }

  writeFileOutput(_lines: string[], _startIndex?: number): void { }

  setMode(_mode: string): void { }

  async start(): Promise<void> { }
  destroy(): void { }

  abort(): void {
    this._abortController.abort();
  }
  resetAbort(): void {
    this._abortController = new AbortController();
  }
}
