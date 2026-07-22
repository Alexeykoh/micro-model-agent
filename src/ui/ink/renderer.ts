import { render as inkRender } from 'ink';
import React from 'react';
import type { OutputRenderer, StatusInfo } from '../renderer.js';
import { App, type AppHandle } from './components/App.js';

/**
 * Ink-рендерер — React-based рендерер с rich UI.
 *
 * Использует Ink (React для терминалов) для отображения:
 * - Streaming markdown с подсветкой синтаксиса
 * - Интерактивного ввода с автодополнением
 * - Status bar с контекстом и прогрессом
 * - Спиннера во время генерации
 *
 * @module ui/ink/renderer
 */

interface CommandInfo {
  name: string;
  description: string;
}

/** Ink-рендерер — React-based rich UI для терминала */
export class InkRenderer implements OutputRenderer {
  private handle: AppHandle | null = null;
  private handleReady: Promise<void>;
  private resolveReady!: () => void;
  private inkResult: { unmount: () => void; clear: () => void } | null = null;
  private _commands: CommandInfo[] = [];
  private abortController: AbortController | null = null;

  get abortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  constructor() {
    this.handleReady = new Promise((resolve) => { this.resolveReady = resolve; });
    this.abortController = new AbortController();
  }

  setCommands(cmds: CommandInfo[]): void {
    this._commands = cmds;
  }

  abort(): void {
    this.abortController?.abort();
  }

  resetAbort(): void {
    this.abortController = new AbortController();
  }

  setMode(mode: string): void {
    this.dispatch({ type: 'SET_MODE', mode });
  }

  async start(): Promise<void> {
    this.inkResult = inkRender(
      React.createElement(App, {
        commands: this._commands,
        onReady: (handle: AppHandle) => {
          this.handle = handle;
          this.resolveReady();
        },
        onAbort: () => {
          this.abort();
        },
      }),
      { exitOnCtrlC: false }
    );
  }

  destroy(): void {
    this.inkResult?.unmount();
    this.inkResult = null;
    this.handle = null;
  }

  private async dispatch(action: any): Promise<void> {
    if (!this.handle) await this.handleReady;
    this.handle?.dispatch(action);
  }

  write(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: text } });
  }

  writeLine(text?: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: text ?? '' } });
  }

  writeNewline(): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: '' } });
  }

  writeInfo(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'info', content: text } });
  }

  writeSuccess(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'success', content: text } });
  }

  writeWarning(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'warning', content: text } });
  }

  writeError(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'error', content: text } });
  }

  writeDim(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'dim', content: text } });
  }

  writePlugins(names: string[]): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'plugins', content: names.join(', ') } });
  }

  setStreamRole(_role: 'assistant' | 'subagent' | 'expert' | null): void {
    // Ink mode uses its own streaming state — no-op
  }

  writeBracketTag(tag: string, message: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'bracket', tag, message } });
  }

  writeHeading(text: string): void {
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'heading', content: text } });
  }

  writeToolHeader(name: string): void {
    this.dispatch({ type: 'ADD_TOOL_CALL', data: { name } });
  }

  writeToolPreview(toolName: string, argsJson: string): void {
    this.dispatch({ type: 'TOOL_PREVIEW', data: { args: argsJson } });
  }

  writeToolResult(time: string, exitCode?: number, result?: string): void {
    this.dispatch({ type: 'TOOL_END', data: { time, exitCode, result } });
  }

  writeToolBuffer(data: { lines: string[]; toolCalls: { name: string; args: string; result: string }[] }): void {
    this.dispatch({ type: 'TOOL_BUFFER', data });
  }

  writeMarkdownChunk(chunk: string): void {
    this.dispatch({ type: 'STREAM_CHUNK', chunk });
  }

  commitMarkdown(): void {
    this.dispatch({ type: 'STREAM_END' });
  }

  writeSpinner(text?: string): void {
    this.dispatch({ type: 'SPINNER', show: true });
  }

  clearSpinner(): void {
    this.dispatch({ type: 'SPINNER', show: false });
  }

  updateContextUsage(text: string): void {
    this.dispatch({ type: 'CONTEXT', text });
  }

  updateStatus(info: StatusInfo): void {
    this.dispatch({ type: 'STATUS', info });
  }

  clear(): void {
    this.dispatch({ type: 'CLEAR' });
  }

  undoLastMessage(): void {
    this.dispatch({ type: 'UNDO_LAST_MESSAGE' });
  }

  async prompt(msg: string): Promise<string> {
    await this.dispatch({ type: 'SHOW_PROMPT', message: msg });
    return new Promise((resolve) => {
      this.handle!.setPromptResolve(resolve);
    });
  }

  async promptWithChoices(msg: string, choices: string[]): Promise<string> {
    await this.dispatch({ type: 'SHOW_SELECT', question: msg, choices });
    return new Promise((resolve) => {
      this.handle!.setSelectResolve(resolve);
    });
  }

  writeFileOutput(lines: string[], startIndex = 1): void {
    const text = lines.map((line, i) => {
      const lineNum = (startIndex + i).toString().padStart(4);
      return `${lineNum}| ${line}`;
    }).join('\n');
    this.dispatch({ type: 'ADD_MESSAGE', kind: 'message', data: { type: 'message', content: text } });
  }
}
