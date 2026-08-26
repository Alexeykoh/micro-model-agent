import * as readline from "readline";
import stringWidth from "string-width";
import {
  buildLayout,
  layoutIndexFor,
  visualColAt,
  charOffsetFor,
  charLen,
  stripAnsi,
  type LayoutRow,
} from "./line-math";

export interface LineInput {
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  write(s: string): void;
  question(query: string, cb: (answer: string) => void): void;
  close(): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
}

export interface LineEditorOptions {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  output: NodeJS.WritableStream & { columns?: number };
  prompt?: string;
  completer?: (line: string) => [string[], string];
  history?: string[];
  historySize?: number;
  tabSize?: number;
  /**
   * Ctrl+C handler. Default: emit "SIGINT" when a listener exists (the REPL
   * installs one). Injectable so tests never fire process-level signals —
   * under load a real SIGINT can terminate the whole test runner.
   */
  onInterrupt?: () => void;
}

interface EditorListeners {
  line?: (line: string) => void;
  close?: () => void;
}

export class LineEditor implements LineInput {
  input: LineEditorOptions["input"];
  output: LineEditorOptions["output"];

  /** Host hook: return true to swallow the key before the editor handles it. */
  onKeyInput?: (str: string, key: unknown) => boolean;
  private onInterrupt?: () => void;

  private promptStr: string;
  private completer?: (line: string) => [string[], string];
  private history: string[];
  private historySize: number;
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  private historyIndex = -1;
  private stash: { lines: string[]; row: number; col: number } | null = null;
  private isDone = false;
  private isPaste = false;
  /** Pasted characters accumulated between `paste-start` and `paste-end`.
   *  Inserted as a single batch on `paste-end` — one render instead of one
   *  per keypress, so a paste appears as a paste, not as fast typing. */
  private pasteBuffer = "";
  /** Whether the last paste keypress was a bare CR — used to collapse a
   *  CRLF pair into a single newline (Windows clipboard text). */
  private pasteLastWasCR = false;
  private lastWasCR = false;
  private questionCb: ((answer: string) => void) | null = null;
  private rawMode = false;
  private listeners: EditorListeners = {};
  /** stdin handlers registered in the constructor — removed in close() so
   *  re-creating the editor never accumulates stale listeners. */
  private dsrDataHandler?: (buf: Buffer | string) => void;
  private keypressHandler?: (str: string, key: unknown) => void;
  private dataHandler?: (buf: Buffer) => void;
  private endHandler?: () => void;
  /** Visual row (within the drawn frame) where the cursor was placed by the
   *  last render — fallback for moving back to the frame's first row before
   *  redrawing when no absolute anchor is known yet. Relative moves break
   *  once the terminal scrolls (the frame shifts up on screen while the
   *  relative count does not), which duplicated multi-line input. */
  private prevCursorRow = 0;
  /** Absolute 1-based screen row of the frame's first visual row, learned
   *  from a single DSR cursor-position report (`ESC[6n`) sent once per
   *  prompt presentation. After the initial query the anchor is updated
   *  deterministically via scroll math — no further queries are sent,
   *  avoiding ConPTY desync. Falls back to relative moves when the reply
   *  never arrives (timeout / broken terminal). */
  private frameTopAbs: number | null = null;
  /** True while waiting for a DSR reply (exactly one outstanding query). */
  private dsrPending = false;
  /** Buffer for partial DSR escape sequences split across data chunks. */
  private dsrTail = "";

  constructor(opts: LineEditorOptions) {
    this.input = opts.input;
    this.output = opts.output;
    this.promptStr = opts.prompt ?? "";
    this.completer = opts.completer;
    this.onInterrupt = opts.onInterrupt;
    this.history = opts.history ?? [];
    this.historySize = opts.historySize ?? 50;
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(-this.historySize);
    }

    if (this.input.isTTY) {
      this.rawMode = typeof this.input.setRawMode === "function";
      if (this.rawMode) this.input.setRawMode!(true);
      this.enableTerminalProtocols();
      // Raw data listener for DSR cursor-position replies. Runs alongside
      // readline's keypress emitter (both receive every chunk); replies may
      // arrive merged with regular keystrokes, hence the global regex.
      this.dsrDataHandler = (buf: Buffer | string) =>
        this.consumeDsrReplies(buf.toString("utf-8"));
      (this.input as any).on("data", this.dsrDataHandler);
      readline.emitKeypressEvents(this.input as never);
      this.keypressHandler = (str: string, key: unknown) => this.onKey(str, key);
      (this.input as any).on("keypress", this.keypressHandler);
    } else {
      this.dataHandler = (buf: Buffer) => this.onData(buf);
      (this.input as any).on("data", this.dataHandler);
      this.endHandler = () => {
        const last = this.lines.join("\n");
        this.lines = [""];
        this.row = 0;
        this.col = 0;
        if (last) this.emitLine(last);
        this.emitClose();
      };
      (this.input as any).on("end", this.endHandler);
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
    this.insertText(s);
  }

  reset(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.historyIndex = -1;
    this.stash = null;
    this.invalidateAnchor();
    if (this.input.isTTY) this.render();
  }

  question(query: string, cb: (answer: string) => void): void {
    this.questionCb = cb;
    this.promptStr = query;
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.invalidateAnchor();
    if (this.input.isTTY) this.render();
  }

  close(): void {
    if (this.isDone) return;
    this.isDone = true;
    this.disableTerminalProtocols();
    const inp = this.input as any;
    if (this.dsrDataHandler) inp.removeListener("data", this.dsrDataHandler);
    if (this.keypressHandler) inp.removeListener("keypress", this.keypressHandler);
    if (this.dataHandler) inp.removeListener("data", this.dataHandler);
    if (this.endHandler) inp.removeListener("end", this.endHandler);
    if (this.rawMode && this.input.setRawMode) {
      this.input.setRawMode(false);
    }
    this.emitClose();
  }

  // ---- input handling ----

  private onData(buf: Buffer): void {
    if (this.isDone) return;
    let text = buf.toString("utf-8");
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i < parts.length - 1) {
        this.emitLine(parts[i]);
        this.lines = [""];
        this.row = 0;
        this.col = 0;
      } else if (parts[i]) {
        this.emitLine(parts[i]);
        this.lines = [""];
        this.row = 0;
        this.col = 0;
      }
    }
  }

  private onKey(str: string, key: unknown): void {
    if (this.isDone) return;
    if (this.onKeyInput && this.onKeyInput(str, key)) return;

    const k = key as {
      name?: string;
      sequence?: string;
      ctrl?: boolean;
      meta?: boolean;
    };
    const name = k?.name ?? "undefined";
    const seq = k?.sequence ?? str ?? "";

    if (name === "undefined" && /^\x1b\[\d+(?:;\d+)?u$/.test(seq)) {
      const m = seq.match(/^\x1b\[(\d+)(?:;(\d+))?u$/);
      if (m && Number(m[1]) === 13 && Number(m[2] ?? 0) !== 0) {
        this.insertNewline();
      }
      return;
    }

    if (name === "paste-start" || seq === "\x1b[200~") {
      this.isPaste = true;
      this.pasteBuffer = "";
      this.pasteLastWasCR = false;
      return;
    }
    if (name === "paste-end" || seq === "\x1b[201~") {
      this.isPaste = false;
      if (this.pasteBuffer) {
        this.insertPaste(this.pasteBuffer);
      } else {
        this.render();
      }
      this.pasteBuffer = "";
      this.pasteLastWasCR = false;
      return;
    }
    if (this.isPaste) {
      if (name === "return" || seq === "\r") {
        this.pasteBuffer += "\n";
        this.pasteLastWasCR = true;
      } else if (name === "enter" || seq === "\n") {
        if (this.pasteLastWasCR) {
          this.pasteLastWasCR = false;
        } else {
          this.pasteBuffer += "\n";
        }
      } else if (str) {
        this.pasteLastWasCR = false;
        this.pasteBuffer += str;
      }
      return;
    }

    if (name === "return" && (seq === "\x1b\r" || k.meta)) {
      this.insertNewline();
      return;
    }
    if (name === "undefined" && seq === "\x1b\r") {
      this.insertNewline();
      return;
    }
    if (k?.ctrl && name === "j") {
      this.insertNewline();
      return;
    }
    if (name === "escape") return;

    switch (name) {
      case "return":
        this.lastWasCR = true;
        this.submit();
        return;
      case "enter":
        if (this.lastWasCR) {
          this.lastWasCR = false;
          return;
        }
        // In question mode, LF should also submit (script/pipes send
        // \n without preceding \r, unlike real terminals).
        if (this.questionCb) {
          this.submit();
          return;
        }
        this.insertNewline();
        return;
      case "backspace":
        this.lastWasCR = false;
        this.backspace();
        return;
      case "delete":
        this.lastWasCR = false;
        this.deleteForward();
        return;
      case "left":
        this.lastWasCR = false;
        this.moveLeft();
        return;
      case "right":
        this.lastWasCR = false;
        this.moveRight();
        return;
      case "up":
        this.lastWasCR = false;
        this.moveUp();
        return;
      case "down":
        this.lastWasCR = false;
        this.moveDown();
        return;
      case "home":
        this.lastWasCR = false;
        this.moveHome();
        return;
      case "end":
        this.lastWasCR = false;
        this.moveEnd();
        return;
      case "pageup":
        this.lastWasCR = false;
        this.moveToStart();
        return;
      case "pagedown":
        this.lastWasCR = false;
        this.moveToEnd();
        return;
      case "tab":
        this.lastWasCR = false;
        this.tabComplete();
        return;
    }

    if (k?.ctrl) {
      this.lastWasCR = false;
      switch (name) {
        case "c":
          this.ctrlC();
          return;
        case "d":
          this.ctrlD();
          return;
        case "a":
          this.moveHome();
          return;
        case "e":
          this.moveEnd();
          return;
        case "u":
          this.killToStart();
          return;
        case "k":
          this.killToEnd();
          return;
        case "w":
          this.killWordBefore();
          return;
        case "l":
          this.clearScreen();
          return;
        default:
          return;
      }
    }

    if (k?.meta) {
      this.lastWasCR = false;
      switch (name) {
        case "b":
          this.moveWordLeft();
          return;
        case "f":
          this.moveWordRight();
          return;
        case "d":
          this.killWordAfter();
          return;
        default:
          return;
      }
    }

    if (str && !/^[\u0000-\u001f\u007f]/.test(str)) {
      this.lastWasCR = false;
      this.insertText(str);
    }
  }

  private submit(): void {
    if (this.questionCb) {
      const cb = this.questionCb;
      this.questionCb = null;
      const answer = this.lines.join("\n").trim();
      this.commitFrame();
      this.output.write("\r\n");
      this.invalidateAnchor();
      this.lines = [""];
      this.row = 0;
      this.col = 0;
      cb(answer);
      return;
    }
    const text = this.lines.join("\n");
    if (text.trim()) {
      this.history.push(text);
      if (this.history.length > this.historySize) {
        this.history = this.history.slice(-this.historySize);
      }
    }
    this.historyIndex = -1;
    this.stash = null;
    this.commitFrame();
    this.output.write("\r\n");
    this.invalidateAnchor();
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.emitLine(text);
  }

  /** Move the cursor to the end of the buffer's last visual row so the
   *  submitted text stays on screen (commit), without erasing the frame.
   *  Uses the absolute anchor when known — relative moves land short once
   *  a tall frame has scrolled the terminal. */
  private commitFrame(): void {
    const layout = this.visibleLayout();
    const lastLen = charLen(stripAnsi(layout[layout.length - 1].text));
    if (this.frameTopAbs !== null) {
      this.output.write(`\x1b[${this.frameTopAbs + layout.length - 1};${lastLen + 1}H`);
      return;
    }
    const idx = layoutIndexFor(layout, this.row, this.col);
    const rowsDown = layout.length - 1 - idx;
    const out: string[] = [];
    if (rowsDown > 0) out.push(`\x1b[${rowsDown}B`);
    out.push("\r");
    if (lastLen > 0) out.push(`\x1b[${lastLen}C`);
    this.output.write(out.join(""));
  }

  private ctrlC(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.invalidateAnchor();
    this.render();
    if (this.onInterrupt) {
      this.onInterrupt();
      return;
    }
    // Default: emit only when someone listens. With zero handlers
    // process.emit("SIGINT") takes the DEFAULT action (process termination);
    // the REPL always installs a listener, so production is unaffected.
    if (process.listenerCount("SIGINT") > 0) {
      process.emit("SIGINT");
    }
  }

  private ctrlD(): void {
    if (this.lines.length === 1 && this.lines[0] === "") {
      this.emitClose();
    } else {
      this.deleteForward();
    }
  }

  // ---- editing primitives ----

  private currentChars(): string[] {
    return Array.from(this.lines[this.row]);
  }

  private setCurrentChars(chars: string[]): void {
    this.lines[this.row] = chars.join("");
  }

  private insertText(text: string): void {
    const sanitized = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const chars = this.currentChars();
    const t = Array.from(sanitized);
    chars.splice(this.col, 0, ...t);
    this.setCurrentChars(chars);
    this.col += t.length;
    this.render();
  }

  /** Bulk-insert pasted text at the cursor. Splits on newlines so the buffer
   *  keeps one string per line (instead of embedding literal `\n` chars),
   *  and renders once — a paste must look like a paste, not like typing. */
  private insertPaste(text: string): void {
    const segments = text.split("\n");
    if (segments.length === 1) {
      this.insertText(segments[0]);
      return;
    }
    const chars = this.currentChars();
    const head = chars.slice(0, this.col).join("");
    const tail = chars.slice(this.col).join("");
    const lines: string[] = [head + segments[0]];
    for (let i = 1; i < segments.length - 1; i++) lines.push(segments[i]);
    lines.push(segments[segments.length - 1] + tail);
    this.lines.splice(this.row, 1, ...lines);
    this.row += segments.length - 1;
    this.col = charLen(segments[segments.length - 1]);
    this.render();
  }

  private insertNewline(): void {
    const chars = this.currentChars();
    const rest = chars.slice(this.col).join("");
    this.setCurrentChars(chars.slice(0, this.col));
    this.lines.splice(this.row + 1, 0, rest);
    this.row++;
    this.col = 0;
    this.render();
  }

  private backspace(): void {
    const chars = this.currentChars();
    if (this.col > 0) {
      chars.splice(this.col - 1, 1);
      this.setCurrentChars(chars);
      this.col--;
    } else if (this.row > 0) {
      const prevLen = charLen(this.lines[this.row - 1]);
      this.lines[this.row - 1] = this.lines[this.row - 1] + this.lines[this.row];
      this.lines.splice(this.row, 1);
      this.row--;
      this.col = prevLen;
    }
    this.render();
  }

  private deleteForward(): void {
    const chars = this.currentChars();
    if (this.col < chars.length) {
      chars.splice(this.col, 1);
      this.setCurrentChars(chars);
    } else if (this.row < this.lines.length - 1) {
      this.lines[this.row] = this.lines[this.row] + this.lines[this.row + 1];
      this.lines.splice(this.row + 1, 1);
    }
    this.render();
  }

  private killToStart(): void {
    const chars = this.currentChars();
    this.setCurrentChars(chars.slice(this.col));
    this.col = 0;
    this.render();
  }

  private killToEnd(): void {
    const chars = this.currentChars();
    this.setCurrentChars(chars.slice(0, this.col));
    this.render();
  }

  private killWordBefore(): void {
    const chars = this.currentChars();
    let i = this.col;
    while (i > 0 && /\s/.test(chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(chars[i - 1])) i--;
    chars.splice(i, this.col - i);
    this.setCurrentChars(chars);
    this.col = i;
    this.render();
  }

  private killWordAfter(): void {
    const chars = this.currentChars();
    const n = chars.length;
    let i = this.col;
    while (i < n && /\s/.test(chars[i])) i++;
    while (i < n && !/\s/.test(chars[i])) i++;
    chars.splice(this.col, i - this.col);
    this.setCurrentChars(chars);
    this.render();
  }

  // ---- navigation ----

  private moveLeft(): void {
    if (this.col > 0) {
      this.col--;
    } else if (this.row > 0) {
      this.row--;
      this.col = charLen(this.lines[this.row]);
    }
    this.render();
  }

  private moveRight(): void {
    if (this.col < charLen(this.lines[this.row])) {
      this.col++;
    } else if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = 0;
    }
    this.render();
  }

  private moveUp(): void {
    const layout = this.layout();
    const idx = layoutIndexFor(layout, this.row, this.col);
    const vcol = visualColAt(layout, idx, this.col);
    if (idx > 0) {
      const target = layout[idx - 1];
      this.row = target.bufRow;
      this.col = charOffsetFor(layout, idx - 1, vcol);
      this.render();
    } else {
      this.historyPrev();
    }
  }

  private moveDown(): void {
    const layout = this.layout();
    const idx = layoutIndexFor(layout, this.row, this.col);
    const vcol = visualColAt(layout, idx, this.col);
    if (idx < layout.length - 1) {
      const target = layout[idx + 1];
      this.row = target.bufRow;
      this.col = charOffsetFor(layout, idx + 1, vcol);
      this.render();
    } else {
      this.historyNext();
    }
  }

  private moveHome(): void {
    this.col = 0;
    this.render();
  }

  private moveEnd(): void {
    this.col = charLen(this.lines[this.row]);
    this.render();
  }

  private moveToStart(): void {
    this.row = 0;
    this.col = 0;
    this.render();
  }

  private moveToEnd(): void {
    this.row = this.lines.length - 1;
    this.col = charLen(this.lines[this.row]);
    this.render();
  }

  private moveWordLeft(): void {
    const chars = this.currentChars();
    let i = this.col;
    while (i > 0 && /\s/.test(chars[i - 1])) i--;
    while (i > 0 && !/\s/.test(chars[i - 1])) i--;
    this.col = i;
    this.render();
  }

  private moveWordRight(): void {
    const chars = this.currentChars();
    const n = chars.length;
    let i = this.col;
    while (i < n && !/\s/.test(chars[i])) i++;
    while (i < n && /\s/.test(chars[i])) i++;
    this.col = i;
    this.render();
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.stash = {
        lines: this.lines.slice(),
        row: this.row,
        col: this.col,
      };
      this.historyIndex = 0;
    } else if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
    } else {
      return;
    }
    this.applyHistoryEntry();
  }

  private historyNext(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.applyHistoryEntry();
    } else if (this.stash) {
      this.lines = this.stash.lines.slice();
      this.row = this.stash.row;
      this.col = this.stash.col;
      this.historyIndex = -1;
      this.stash = null;
      this.render();
    }
  }

  private applyHistoryEntry(): void {
    const entry = this.history[this.history.length - 1 - this.historyIndex];
    this.lines = entry.split("\n");
    if (this.lines.length === 0) this.lines = [""];
    this.row = this.lines.length - 1;
    this.col = charLen(this.lines[this.row]);
    this.render();
  }

  // ---- completion / misc ----

  private tabComplete(): void {
    if (!this.completer) return;
    const line = this.lines[this.row];
    const [matches, partial] = this.completer(line);
    if (matches.length === 0) {
      this.output.write("\x07");
      return;
    }
    if (matches.length === 1) {
      // Complete the partial under the CURSOR, not the last occurrence in
      // the whole line — with the cursor mid-line, lastIndexOf() inserted
      // at the line's end instead.
      const chars = Array.from(line);
      const beforeCursor = chars.slice(0, this.col).join("");
      let from = beforeCursor.lastIndexOf(partial);
      if (from === -1) from = line.lastIndexOf(partial);
      if (from === -1) {
        this.output.write("\x07");
        return;
      }
      const head = line.slice(0, from);
      const tail = line.slice(from + partial.length);
      this.lines[this.row] = head + matches[0] + tail;
      this.col = charLen(head) + charLen(matches[0]);
      this.render();
      return;
    }
    const rows = matches.map((m) => "  " + m);
    this.output.write("\r\n" + rows.join("\r\n") + "\r\n");
    // The printed list moved the cursor (rows.length + 1) visual rows down
    // from its frame position. Account for those rows so the next render
    // redraws the frame in place — otherwise its relative up-move starts
    // above the frame and paints garbage over the just-printed list.
    this.prevCursorRow += rows.length + 1;
    this.render();
  }

  private clearScreen(): void {
    this.output.write("\x1b[2J\x1b[H");
    this.invalidateAnchor();
    this.render();
  }

  // ---- rendering ----

  private columns(): number {
    return this.output.columns || 80;
  }

  private layout(): LayoutRow[] {
    const promptWidth = stringWidth(stripAnsi(this.promptStr));
    return buildLayout(
      this.lines,
      this.columns(),
      Math.max(1, this.columns() - promptWidth),
    );
  }

  /** 1-based terminal height, or null when unknown (tests / non-TTY). */
  private screenRows(): number | null {
    const r = (this.output as { rows?: number }).rows;
    return typeof r === "number" && r > 3 ? r : null;
  }

  /** Cap the rendered frame to the visible screen. A frame taller than the
   *  terminal cannot be redrawn in place at all (its top scrolls off), so
   *  only the tail is drawn; the absolute anchor keeps the next render
   *  consistent regardless. */
  private visibleLayout(): LayoutRow[] {
    const layout = this.layout();
    const H = this.screenRows();
    const maxRows = H ? H - 2 : 0;
    if (maxRows > 0 && layout.length > maxRows) {
      return layout.slice(layout.length - maxRows);
    }
    return layout;
  }

  /** Forget the learned absolute frame position — the cursor has jumped to
   *  an unknown location (external output, clear screen, fresh prompt).
   *  The next render will re-query via DSR. */
  private invalidateAnchor(): void {
    this.frameTopAbs = null;
    this.dsrPending = false;
    this.dsrTail = "";
    this.prevCursorRow = 0;
  }

  /** Parse `ESC[row;colR` cursor-position replies. Buffers partial escape
   *  sequences across chunks. Accepts at most one reply (the outstanding
   *  query); extras are silently dropped. Validates the reported row against
   *  `screenRows()` to reject implausible ConPTY values. */
  private consumeDsrReplies(chunk: string): void {
    this.dsrTail = (this.dsrTail + chunk).slice(-80);
    const m = /\x1b\[(\d+);(\d+)R/.exec(this.dsrTail);
    if (!m) return;
    this.dsrTail = "";
    if (!this.dsrPending) return;
    this.dsrPending = false;
    const row = Number(m[1]);
    const idx = Number(m[2]);
    // idx is not the layout index — it's the column from the reply; ignore it.
    // We compute frameTop from the reply row minus the cursor's visual row
    // at query time.  The visual row was stored in `prevCursorRow` when the
    // query was sent (right after render).
    const top = row - this.prevCursorRow;
    if (top >= 1) this.frameTopAbs = top;
  }

  private render(): void {
    if (!this.input.isTTY || this.isDone) return;
    const layout = this.visibleLayout();
    const promptWidth = stringWidth(stripAnsi(this.promptStr));
    const idx = layoutIndexFor(layout, this.row, this.col);
    const vcol = visualColAt(layout, idx, this.col);
    const rowsAfter = layout.length - idx - 1;
    const ccol = (idx === 0 ? promptWidth : 0) + vcol;

    const out: string[] = [];
    // Return to the frame's first row before redrawing.  Absolute
    // positioning (learned via a single DSR query per prompt) is
    // scroll-proof; relative up-moves are the fallback until the
    // initial reply arrives.
    if (this.frameTopAbs !== null) {
      out.push(`\x1b[${this.frameTopAbs};1H`);
    } else if (this.prevCursorRow > 0) {
      out.push(`\x1b[${this.prevCursorRow}A`);
      out.push("\r");
    } else {
      out.push("\r");
    }
    for (let i = 0; i < layout.length; i++) {
      out.push("\x1b[2K");
      if (i === 0) out.push(this.promptStr);
      out.push(layout[i].text);
      if (i < layout.length - 1) out.push("\r\n");
    }
    out.push("\x1b[J");
    if (rowsAfter > 0) out.push(`\x1b[${rowsAfter}A`);
    out.push("\r");
    if (ccol > 0) out.push(`\x1b[${ccol}C`);
    this.output.write(out.join(""));

    // Deterministic scroll math: update the anchor for the NEXT render.
    // After writing L rows starting from frameTopAbs, if the frame extends
    // past the screen bottom the terminal scrolls; the new frame top is
    // computed locally — no further DSR queries needed.
    if (this.frameTopAbs !== null) {
      const H = this.screenRows();
      if (H) {
        const T = this.frameTopAbs;
        const L = layout.length;
        if (T + L - 1 > H) this.frameTopAbs = H - L + 1;
        // else: no scroll, anchor unchanged
      }
    } else if (!this.dsrPending) {
      // First render after prompt — send exactly ONE DSR query.
      // Disabled for now: ConPTY may buffer stdout while processing
      // the DSR reply, hiding agent responses.  Will revisit once
      // scroll-proof rendering is solved via deterministic tracking.
      //
      // this.dsrPending = true;
      // this.output.write("\x1b[6n");
    }

    this.prevCursorRow = idx;
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
    this.listeners.close?.();
  }
}
