import { render as inkRender } from 'ink';
import React from 'react';
import type { OutputRenderer, StatusInfo } from '../renderer.js';
import { App, type AppHandle } from './components/App.js';

interface CommandInfo {
  name: string;
  description: string;
}

export class InkRenderer implements OutputRenderer {
  private handle: AppHandle | null = null;
  private inkResult: { unmount: () => void; clear: () => void } | null = null;
  private _commands: CommandInfo[] = [];

  readonly abortSignal: AbortSignal | undefined;

  setCommands(cmds: CommandInfo[]): void {
    this._commands = cmds;
  }

  async start(): Promise<void> {
    this.inkResult = inkRender(
      React.createElement(App, {
        commands: this._commands,
        onReady: (handle: AppHandle) => { this.handle = handle; },
      })
    );
  }

  destroy(): void {
    this.inkResult?.unmount();
    this.inkResult = null;
    this.handle = null;
  }

  private dispatch(action: any): void {
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

  writeToolResult(time: string, exitCode?: number): void {
    this.dispatch({ type: 'TOOL_END', data: { time, exitCode } });
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

  async prompt(msg: string): Promise<string> {
    this.dispatch({ type: 'SHOW_PROMPT', message: msg });
    return new Promise((resolve) => {
      this.handle?.setPromptResolve(resolve);
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
