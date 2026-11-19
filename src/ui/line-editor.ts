// Строчный редактор: raw-ввод, история, Tab-комплит, DSR-якорь кадра.
// Рендер/DSR — `line-editor-render`, буфер — `line-editor-buffer`, навигация и
// история — `line-editor-nav`, клавиши — `line-editor-keys`, комплит —
// `line-editor-completion`, типы — `line-editor-types` (правило 6).
import * as readline from "readline";
import type { LayoutRow } from "./line-math";
import { LineBuffer, type CompletionSession } from "./line-editor-buffer";
import { LineRenderer } from "./line-editor-render";
import { EditorInput } from "./line-editor-input";
import type { CompletionHost } from "./line-editor-completion";
import type {
  CompletionItem,
  EditorListeners,
  LineEditorOptions,
  LineInput,
} from "./line-editor-types";

export type { CompletionItem, LineEditorOptions, LineInput } from "./line-editor-types";

/** Многострочный редактор ввода с историей и Tab-комплитом (raw-режим TTY). */
export class LineEditor implements LineInput {
  input: LineEditorOptions["input"];
  output: LineEditorOptions["output"];

  /** Хук хоста: true — поглотить клавишу до обработки редактором. */
  onKeyInput?: (str: string, key: unknown) => boolean;
  private onInterrupt?: () => void;

  private promptStr: string;
  private completer?: (line: string, cursor?: number) => [CompletionItem[], string];
  private buf: LineBuffer;
  private frames: LineRenderer;
  private engine: EditorInput;
  private pendingLine = "";
  private done = false;
  private questionCb: ((answer: string) => void) | null = null;
  private rawMode = false;
  private listeners: EditorListeners = {};
  /** stdin-хендлеры из конструктора: снимаются в close(), чтобы пересоздание
   *  редактора не копило протухшие слушатели. */
  private dsrDataHandler?: (buf: Buffer | string) => void;
  private keypressHandler?: (str: string, key: unknown) => void;
  private dataHandler?: (buf: Buffer) => void;
  private endHandler?: () => void;
  /** Выкл — клавиши игнорятся (кроме Ctrl+C), пока агент стримит: терминалом
   *  в этой фазе владеет хост. */
  private inputEnabled = true;
  /** Вкл — кадр промпта не рисуется; экраном владеет агент. */
  private frameSuspended = false;

  constructor(opts: LineEditorOptions) {
    this.input = opts.input;
    this.output = opts.output;
    this.promptStr = opts.prompt ?? "";
    this.completer = opts.completer;
    this.onInterrupt = opts.onInterrupt;
    this.buf = new LineBuffer(opts.history ?? [], opts.historySize ?? 50, () => this.render());
    this.frames = new LineRenderer(this.buf, this.output, () => this.promptStr);
    this.engine = new EditorInput({
      buf: this.buf,
      frames: this.frames,
      output: this.output,
      isDone: () => this.done,
      inputEnabled: () => this.inputEnabled,
      hostKey: (s, k) => this.onKeyInput?.(s, k) ?? false,
      completion: () => this.completionHost(),
      question: () => this.questionCb,
      clearQuestion: () => {
        this.questionCb = null;
      },
      render: () => this.render(),
      emitLine: (line) => this.emitLine(line),
      close: () => this.close(),
      onInterrupt: this.onInterrupt,
    });

    if (this.input.isTTY) {
      this.rawMode = typeof this.input.setRawMode === "function";
      if (this.rawMode) this.input.setRawMode!(true);
      this.enableTerminalProtocols();
      // Сырой слушатель DSR-ответов о позиции курсора. Живёт рядом с keypress-эмитером
      // readline (оба получают каждый чанк); ответы могут приходить склеенными с
      // обычными клавишами — отсюда глобальный regex.
      this.dsrDataHandler = (buf: Buffer | string) => this.frames.consumeDsr(buf.toString("utf-8"));
      this.input.on("data", this.dsrDataHandler);
      readline.emitKeypressEvents(this.input as never);
      this.keypressHandler = (str: string, key: unknown) => this.onKey(str, key);
      this.input.on("keypress", this.keypressHandler);
      // Редактор теперь владеет stdin: взводим flowing, даже если прошлый
      // потребитель его стопил (напр. визард настройки).
      this.input.resume();
    } else {
      this.dataHandler = (buf: Buffer) => this.onData(buf);
      this.input.on("data", this.dataHandler);
      this.endHandler = () => {
        const last = this.buf.lines.join("\n");
        this.buf.lines = [""];
        this.buf.row = 0;
        this.buf.col = 0;
        if (last) this.emitLine(last);
        this.emitClose();
      };
      this.input.on("end", this.endHandler);
    }
  }

  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "line" | "close", listener: (line: string) => void): this {
    if (event === "line") {
      this.listeners.line = listener;
    } else {
      this.listeners.close = listener as () => void;
    }
    return this;
  }

  setPrompt(prompt: string): void {
    this.promptStr = prompt;
    if (this.input.isTTY) this.render();
  }

  prompt(_preserveCursor?: boolean): void {
    if (this.input.isTTY) this.render();
  }

  write(s: string): void {
    this.buf.insertText(s);
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
  }

  isInputEnabled(): boolean {
    return this.inputEnabled;
  }

  isFrameSuspended(): boolean {
    return this.frameSuspended;
  }

  /** Завершён ли редактор (Ctrl+D на пустой строке или явный close). */
  isDone(): boolean {
    return this.done;
  }

  /** Clear the prompt frame (the agent takes over the terminal) and stop
   *  rendering until `resumeFrame()`. */
  suspendFrame(): void {
    if (!this.input.isTTY || this.done) return;
    this.output.write(this.frames.eraseSeq());
    this.frames.invalidate();
    this.frameSuspended = true;
  }

  /** Restore the frame after streaming. */
  resumeFrame(): void {
    this.frameSuspended = false;
    this.frames.invalidate();
    this.render();
  }

  /** Print a block of lines above the current prompt frame without erasing
   *  the input buffer. When the frame is suspended the block is printed in
   *  place and the suspension is preserved. */
  printAbove(text: string): void {
    if (!this.input.isTTY || this.done) {
      this.output.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    const wasSuspended = this.frameSuspended;
    this.frameSuspended = false;
    this.output.write(this.frames.printAboveSeq(text));
    this.frames.invalidate();
    if (wasSuspended) this.frameSuspended = true;
    else this.render();
  }

  reset(): void {
    this.buf.reset();
    this.frames.invalidate();
    if (this.input.isTTY) this.render();
  }

  question(query: string, cb: (answer: string) => void): void {
    this.questionCb = cb;
    this.promptStr = query;
    this.buf.reset();
    this.frames.invalidate();
    if (this.input.isTTY) this.render();
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.disableTerminalProtocols();
    if (this.dsrDataHandler) this.input.removeListener("data", this.dsrDataHandler);
    if (this.keypressHandler) this.input.removeListener("keypress", this.keypressHandler);
    if (this.dataHandler) this.input.removeListener("data", this.dataHandler);
    if (this.endHandler) this.input.removeListener("end", this.endHandler);
    if (this.rawMode && this.input.setRawMode) {
      this.input.setRawMode(false);
    }
    this.frames.dispose();
    this.emitClose();
  }

  clearScreen(): void {
    this.output.write("\x1b[2J\x1b[H");
    this.frames.invalidate();
    this.render();
  }

  private completionHost(): CompletionHost {
    return {
      buf: this.buf,
      output: this.output,
      completer: this.completer,
      columns: () => this.frames.columns(),
      invalidateAnchor: () => this.frames.invalidate(),
      render: () => this.render(),
    };
  }

  private onData(buf: Buffer): void {
    if (this.done) return;
    let text = buf.toString("utf-8");
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = text.split("\n");
    // Незавершённый хвост — в следующий чанк: немедленный эмит разрезал бы
    // `"hello wor" + "ld\n"` на две неверные строки.
    this.pendingLine += parts[0];
    for (let i = 1; i < parts.length; i++) {
      this.emitLine(this.pendingLine);
      this.buf.lines = [""];
      this.buf.row = 0;
      this.buf.col = 0;
      this.pendingLine = parts[i];
    }
  }

  private onKey(str: string, key: unknown): void {
    this.engine.handleKey(str, key);
  }

  // Мост к внутренностям буфера/рендера: на него опираются тесты редактора.
  get lines(): string[] { return this.buf.lines; }
  set lines(value: string[]) { this.buf.lines = value; }
  layout(): LayoutRow[] { return this.frames.layout(); }
  visibleLayout(): LayoutRow[] { return this.frames.visibleLayout(); }
  get frameTopAbs(): number | null { return this.frames.frameTop; }
  set frameTopAbs(value: number | null) { this.frames.frameTop = value; }
  get dsrPending(): boolean { return this.frames.awaitingDsr; }
  get dsrQueryRow(): number { return this.frames.queryRow; }
  get prevCursorRow(): number { return this.frames.cursorRow; }
  get completionSession(): CompletionSession | null { return this.buf.completion; }

  private render(): void {
    if (!this.input.isTTY || this.done || this.frameSuspended) return;
    const frame = this.frames.buildFrame();
    this.output.write(frame.text);
    this.frames.afterRender(frame.layoutLen, frame.idx, this.questionCb !== null);
  }

  private enableTerminalProtocols(): void {
    this.output.write("\x1b[?2004h");
    this.output.write("\x1b[>1u");
  }

  private disableTerminalProtocols(): void {
    this.output.write("\x1b[?2004l");
    this.output.write("\x1b[<u");
  }

  private emitLine(line: string): void {
    this.listeners.line?.(line);
  }

  private emitClose(): void {
    // Сброс финальной строки без перевода из чанкованного не-TTY ввода.
    if (this.pendingLine) {
      this.emitLine(this.pendingLine);
      this.pendingLine = "";
    }
    this.listeners.close?.();
  }
}
