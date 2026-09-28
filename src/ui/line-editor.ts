// Строчный редактор: raw-ввод, история, Tab-комплит, DSR-якорь кадра (см. DSR ниже).
import * as readline from "readline";
import stringWidth from "string-width";
import { pc } from "./colors";
import {
  buildLayout,
  layoutIndexFor,
  visualColAt,
  charOffsetFor,
  charLen,
  stripAnsi,
  type LayoutRow,
} from "./line-math";

/** Входная строка хоста (REPL): промпт, вопрос, печать поверх. */
export interface LineInput {
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  write(s: string): void;
  question(query: string, cb: (answer: string) => void): void;
  close(): void;
  printAbove?(text: string): void;
  on(event: "line", listener: (line: string) => void): this;
  on(event: "close", listener: () => void): this;
}

/** Вариант автокомплита: значение + опц. описание. */
export interface CompletionItem {
  value: string;
  description?: string;
}

/** Опции редактора: потоки, промпт, комплитер, история, обработчик Ctrl+C. */
export interface LineEditorOptions {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  output: NodeJS.WritableStream & { columns?: number };
  prompt?: string;
  completer?: (line: string) => [CompletionItem[], string];
  history?: string[];
  historySize?: number;
  tabSize?: number;
  /**
   * Обработчик Ctrl+C. Дефолт: эмитит "SIGINT", если есть слушатель (REPL его
   * ставит). Инжектится, чтобы тесты не слали процессные сигналы: под нагрузкой
   * настоящий SIGINT может убить весь тест-раннер.
   */
  onInterrupt?: () => void;
}

interface EditorListeners {
  line?: (line: string) => void;
  close?: () => void;
}

/** Многострочный редактор ввода с историей и Tab-комплитом (raw-режим TTY). */
export class LineEditor implements LineInput {
  input: LineEditorOptions["input"];
  output: LineEditorOptions["output"];

  /** Хук хоста: true — поглотить клавишу до обработки редактором. */
  onKeyInput?: (str: string, key: unknown) => boolean;
  private onInterrupt?: () => void;

  private promptStr: string;
  private completer?: (line: string) => [CompletionItem[], string];
  private history: string[];
  private historySize: number;
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  /** Перенос не-TTY чанкованного ввода (частичная строка между чтениями). */
  private pendingLine = "";
  private historyIndex = -1;
  private stash: { lines: string[]; row: number; col: number } | null = null;
  private isDone = false;
  private isPaste = false;
  /** Вставленное копятся между `paste-start` и `paste-end`.
   *  Вставляется одним батчем на `paste-end`: один рендер вместо рендера на
   *  клавишу, чтобы вставка выглядела вставкой, а не быстрой печатью. */
  private pasteBuffer = "";
  /** Была ли последняя вставленная клавиша голым CR: схлопывает CRLF-пару
   *  в один перевод строки (текст из буфера Windows). */
  private pasteLastWasCR = false;
  private lastWasCR = false;
  private questionCb: ((answer: string) => void) | null = null;
  /** Активная Tab-сессия комплита. Пока стоит, ↑/↓/Tab крутят кандидатов, а
   *  Esc возвращает `original`; любая другая клавиша сессию роняет. */
  private completionSession: {
    items: CompletionItem[];
    index: number;
    /** UTF-16 индекс в строке буфера, где начинается дополняемый токен. */
    from: number;
    /** Исходный частичный ввод, который заменили. */
    original: string;
    /** Сейчас вставленное значение-кандидат. */
    inserted: string;
  } | null = null;
  private rawMode = false;
  private listeners: EditorListeners = {};
  /** stdin-хендлеры из конструктора: снимаются в close(), чтобы пересоздание
   *  редактора не копило протухшие слушатели. */
  private dsrDataHandler?: (buf: Buffer | string) => void;
  private keypressHandler?: (str: string, key: unknown) => void;
  private dataHandler?: (buf: Buffer) => void;
  private endHandler?: () => void;
  /** Визуальный ряд (внутри рисуемого кадра), куда последний рендер поставил
   *  курсор. Фолбэк для возврата на первую строку кадра перед перерисовкой,
   *  пока нет абсолютного якоря. Относительные ходы ломаются при скролле
   *  терминала (кадр уезжает вверх, счётчик — нет), что дублировало
   *  многострочный ввод. */
  private prevCursorRow = 0;
  /** Абсолютный 1-based экранный ряд первой визуальной строки кадра. Выучен
   *  из одного DSR-ответа о позиции курсора (`ESC[6n`), шлётся раз на показ
   *  промпта. Дальше якорь ведётся детерминированной скролл-математикой, новых
   *  запросов нет (защита от рассинхрона ConPTY). Без ответа (таймаут/битый
   *  терминал) — фолбэк на относительные ходы. */
  private frameTopAbs: number | null = null;
  /** Ждём ли DSR-ответ (ровно один outstanding-запрос). */
  private dsrPending = false;
  /** Буфер частичных DSR-escape, разрезанных между чанками. */
  private dsrTail = "";
  /** Визуальный ряд курсора ровно в момент отправки outstanding DSR-запроса.
   *  Ответ матчится против него, а не `prevCursorRow`: промежуточные рендеры
   *  перезаписывают тот, пока запрос ещё летит. */
  private dsrQueryRow = 0;
  /** Выкл — клавиши игнорятся (кроме Ctrl+C), пока агент стримит: терминалом
   *  в этой фазе владеет хост. */
  private inputEnabled = true;
  /** Вкл — кадр промпта не рисуется; экраном владеет агент. */
  private frameSuspended = false;
  /** Сбрасывает `dsrPending`, если DSR-ответ не пришёл: фолбэк на относительные
   *  ходы вместо клина на битом терминале. */
  private dsrTimer: ReturnType<typeof setTimeout> | null = null;

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
      // Сырой слушатель DSR-ответов о позиции курсора. Живёт рядом с keypress-эмитером
      // readline (оба получают каждый чанк); ответы могут приходить склеенными с
      // обычными клавишами — отсюда глобальный regex.
      this.dsrDataHandler = (buf: Buffer | string) => this.consumeDsrReplies(buf.toString("utf-8"));
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
        const last = this.lines.join("\n");
        this.lines = [""];
        this.row = 0;
        this.col = 0;
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
    this.insertText(s);
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

  /** Clear the prompt frame (the agent takes over the terminal) and stop
   *  rendering until `resumeFrame()`. */
  suspendFrame(): void {
    if (!this.input.isTTY || this.isDone) return;
    const out: string[] = [];
    if (this.frameTopAbs !== null) out.push(`\x1b[${this.frameTopAbs};1H`);
    else if (this.prevCursorRow > 0) out.push(`\x1b[${this.prevCursorRow}A`);
    out.push("\r\x1b[J");
    this.output.write(out.join(""));
    this.invalidateAnchor();
    this.frameSuspended = true;
  }

  /** Restore the frame after streaming. */
  resumeFrame(): void {
    this.frameSuspended = false;
    this.invalidateAnchor();
    this.render();
  }

  /** Print a block of lines above the current prompt frame without erasing
   *  the input buffer. When the frame is suspended the block is printed in
   *  place and the suspension is preserved. */
  printAbove(text: string): void {
    if (!this.input.isTTY || this.isDone) {
      this.output.write(text.endsWith("\n") ? text : `${text}\n`);
      return;
    }
    const wasSuspended = this.frameSuspended;
    this.frameSuspended = false;
    const out: string[] = [];
    if (this.frameTopAbs !== null) out.push(`\x1b[${this.frameTopAbs};1H`);
    else if (this.prevCursorRow > 0) out.push(`\x1b[${this.prevCursorRow}A`);
    out.push("\r\x1b[J");
    out.push(text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").join("\r\n"));
    out.push("\r\n");
    this.output.write(out.join(""));
    this.invalidateAnchor();
    if (wasSuspended) this.frameSuspended = true;
    else this.render();
  }

  reset(): void {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.historyIndex = -1;
    this.stash = null;
    this.completionSession = null;
    this.invalidateAnchor();
    if (this.input.isTTY) this.render();
  }

  question(query: string, cb: (answer: string) => void): void {
    this.questionCb = cb;
    this.promptStr = query;
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.completionSession = null;
    this.invalidateAnchor();
    if (this.input.isTTY) this.render();
  }

  close(): void {
    if (this.isDone) return;
    this.isDone = true;
    this.disableTerminalProtocols();
    if (this.dsrDataHandler) this.input.removeListener("data", this.dsrDataHandler);
    if (this.keypressHandler) this.input.removeListener("keypress", this.keypressHandler);
    if (this.dataHandler) this.input.removeListener("data", this.dataHandler);
    if (this.endHandler) this.input.removeListener("end", this.endHandler);
    if (this.rawMode && this.input.setRawMode) {
      this.input.setRawMode(false);
    }
    if (this.dsrTimer) {
      clearTimeout(this.dsrTimer);
      this.dsrTimer = null;
    }
    this.emitClose();
  }

  // ── Ввод ──

  private onData(buf: Buffer): void {
    if (this.isDone) return;
    let text = buf.toString("utf-8");
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = text.split("\n");
    // Незавершённый хвост — в следующий чанк: немедленный эмит разрезал бы
    // `"hello wor" + "ld\n"` на две неверные строки.
    this.pendingLine += parts[0];
    for (let i = 1; i < parts.length; i++) {
      this.emitLine(this.pendingLine);
      this.lines = [""];
      this.row = 0;
      this.col = 0;
      this.pendingLine = parts[i];
    }
  }

  private onKey(str: string, key: unknown): void {
    if (this.isDone) return;
    if (!this.inputEnabled) {
      // На стриме уважаются только прерывающие клавиши: Ctrl+C абортит прогон,
      // Esc форвардится, чтобы хост реализовал двойной-Esc аборт.
      const k = key as { name?: string; ctrl?: boolean };
      if (k?.ctrl && k.name === "c") {
        this.ctrlC();
        return;
      }
      if (k?.name === "escape") {
        this.onKeyInput?.(str, key);
        return;
      }
      return;
    }
    // Сессия комплита приоритетнее хост-хуков: Esc обязан вернуть исходный
    // partial, а не дёрнуть хостовый Esc-хендлинг; стрелки/Tab — крутить.
    // Любая другая клавиша роняет сессию и обрабатывается обычно (с хост-хуком).
    if (this.completionSession) {
      const ck = key as { name?: string; ctrl?: boolean; meta?: boolean };
      const plain = !ck.ctrl && !ck.meta;
      if (ck?.name === "down" && plain) {
        this.cycleCompletion(1);
        return;
      }
      if (ck?.name === "up" && plain) {
        this.cycleCompletion(-1);
        return;
      }
      if (ck?.name === "tab") {
        this.cycleCompletion(1);
        return;
      }
      if (ck?.name === "escape") {
        this.cancelCompletion();
        return;
      }
      this.completionSession = null;
    }

    if (this.onKeyInput?.(str, key)) return;

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

    // Отчёт о позиции курсора (`ESC[row;colR`) — никогда не ввод: на части связок
    // Windows/ConPTY + Bun хвостовой "R" протекает в буфер и портит ответ
    // (каждый промпт отвечал "R"). Глотаем последовательность целиком.
    if (/^\x1b\[\d+;\d+R$/.test(seq)) return;

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
        // В question-режиме LF тоже сабмитит (скрипты/пайпы шлют \n без \r спереди,
        // в отличие от настоящих терминалов).
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
    this.completionSession = null;
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
    this.completionSession = null;
    this.invalidateAnchor();
    this.render();
    if (this.onInterrupt) {
      this.onInterrupt();
      return;
    }
    // Дефолт: эмитим, только если слушают. С нулём хендлеров process.emit("SIGINT")
    // выполняет действие ПО УМОЛЧАНИЮ (смерть процесса); у REPL слушатель всегда
    // стоит, так что прод не страдает.
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

  // ── Примитивы правки ──

  private currentChars(): string[] {
    return Array.from(this.lines[this.row]);
  }

  private setCurrentChars(chars: string[]): void {
    this.lines[this.row] = chars.join("");
  }

  private insertText(text: string): void {
    this.completionSession = null;
    const sanitized = text.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const chars = this.currentChars();
    const t = Array.from(sanitized);
    chars.splice(this.col, 0, ...t);
    this.setCurrentChars(chars);
    this.col += t.length;
    this.render();
  }

  /** Пакетная вставка текста под курсор. Режет по переводам строк, чтобы буфер
   *  держал строку на элемент (а не литеральные `\n`), и рендерит один раз:
   *  вставка должна выглядеть вставкой, а не печатью. */
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
    this.completionSession = null;
    const entry = this.history[this.history.length - 1 - this.historyIndex];
    this.lines = entry.split("\n");
    if (this.lines.length === 0) this.lines = [""];
    this.row = this.lines.length - 1;
    this.col = charLen(this.lines[this.row]);
    this.render();
  }

  // ---- completion / misc ----

  /** Replace the UTF-16 range `[from, from + removeText.length)` on the
   *  current buffer line with `insertText`, placing the cursor right after. */
  private replaceCompletionToken(from: number, removeText: string, insertText: string): void {
    const line = this.lines[this.row];
    const head = line.slice(0, from);
    const tail = line.slice(from + removeText.length);
    this.lines[this.row] = head + insertText + tail;
    this.col = charLen(head) + charLen(insertText);
  }

  /** Position of `partial` under the cursor (fallback: last in the line), or
   *  -1 when not found. */
  private partialStart(line: string, partial: string): number {
    const chars = Array.from(line);
    const beforeCursor = chars.slice(0, this.col).join("");
    let from = beforeCursor.lastIndexOf(partial);
    if (from === -1) from = line.lastIndexOf(partial);
    return from;
  }

  private applyCompletionCandidate(index: number): void {
    const s = this.completionSession;
    if (!s) return;
    const chosen = s.items[index].value;
    this.replaceCompletionToken(s.from, s.inserted, chosen);
    s.index = index;
    s.inserted = chosen;
    this.render();
  }

  private cycleCompletion(delta: number): void {
    const s = this.completionSession;
    if (!s) return;
    const n = s.items.length;
    if (n === 0) return;
    const next = (s.index + delta + n) % n;
    this.applyCompletionCandidate(next);
  }

  private cancelCompletion(): void {
    const s = this.completionSession;
    if (!s) return;
    this.replaceCompletionToken(s.from, s.inserted, s.original);
    this.completionSession = null;
    this.render();
  }

  private tabComplete(): void {
    if (!this.completer) return;
    const line = this.lines[this.row];
    const [matches, partial] = this.completer(line);
    if (matches.length === 0) {
      this.output.write("\x07");
      return;
    }
    if (matches.length === 1) {
      // Дополняем partial ПОД КУРСОРОМ, а не последнее вхождение в строке: при
      // курсоре в середине lastIndexOf() вставлял в конец строки.
      const from = this.partialStart(line, partial);
      if (from === -1) {
        this.output.write("\x07");
        return;
      }
      this.replaceCompletionToken(from, partial, matches[0].value);
      this.render();
      return;
    }
    const from = this.partialStart(line, partial);
    if (from === -1) {
      this.output.write("\x07");
      return;
    }
    const width = this.columns();
    const limit = width - 1;
    const rows = matches.map((m) => {
      const plain = m.description ? `  ${m.value}  ${m.description}` : `  ${m.value}`;
      if (limit <= 0) return "";
      if (stringWidth(plain) <= limit) {
        return m.description ? `  ${m.value}  ${pc.dim(m.description)}` : `  ${m.value}`;
      }
      // Режем по видимым колонкам (одних кодпоинтов мало для CJK/emoji).
      let acc = "";
      let w = 0;
      for (const ch of plain) {
        const cw = stringWidth(ch);
        if (w + cw > limit - 1) break;
        acc += ch;
        w += cw;
      }
      return `${acc}…`;
    });
    this.output.write(`\r\n${rows.join("\r\n")}\r\n`);
    // Напечатанный список увёл курсор ниже старого кадра. Сбрасываем абсолютный
    // якорь, чтобы следующий рендер позиционировался ОТНОСИТЕЛЬНО текущего
    // курсора (под списком). Сохранение DSR-якоря возвращало кадр на старую
    // абсолютную строку, и его `\x1b[J` стирал список: на Linux/macOS кандидаты
    // мигали и исчезали.
    this.invalidateAnchor();

    // Старт сессии циклирования с первым кандидатом в буфере:
    // ↑/↓/Tab крутят напечатанный список на месте.
    this.completionSession = {
      items: matches,
      index: 0,
      from,
      original: partial,
      inserted: matches[0].value,
    };
    this.replaceCompletionToken(from, partial, matches[0].value);
    this.render();
  }

  clearScreen(): void {
    this.output.write("\x1b[2J\x1b[H");
    this.invalidateAnchor();
    this.render();
  }

  // ── Рендеринг ──

  private columns(): number {
    return this.output.columns || 80;
  }

  private layout(): LayoutRow[] {
    const promptWidth = stringWidth(stripAnsi(this.promptStr));
    return buildLayout(this.lines, this.columns(), Math.max(1, this.columns() - promptWidth));
  }

  /** 1-based высота терминала, null — неизвестна (тесты / не-TTY). */
  private screenRows(): number | null {
    const r = (this.output as { rows?: number }).rows;
    return typeof r === "number" && r > 3 ? r : null;
  }

  /**
   * Можно ли слать запрос позиции курсора (`ESC[6n`). На Windows — opt-in:
   * ConPTY может декодировать ответ `ESC[row;colR` как ввод, что портит ответы
   * (визард настройки отвечал на каждый промпт "R").
   * `MMA_DSR=1` форсит вкл, `MMA_DSR=0` — выкл; иначе по умолчанию вкл.
   */
  private dsrEnabled(): boolean {
    if (process.env.MMA_DSR === "1") return true;
    if (process.env.MMA_DSR === "0") return false;
    return process.platform !== "win32";
  }

  /** Режет рисуемый кадр до видимого экрана. Кадр выше терминала нельзя
   *  перерисовать на месте (верх уехал в скролл), так что рисуется только хвост;
   *  абсолютный якорь держит следующий рендер консистентным в любом случае. */
  private visibleLayout(): LayoutRow[] {
    const layout = this.layout();
    const H = this.screenRows();
    const maxRows = H ? H - 2 : 0;
    if (maxRows > 0 && layout.length > maxRows) {
      return layout.slice(layout.length - maxRows);
    }
    return layout;
  }

  /** Забывает выученную абсолютную позицию кадра: курсор прыгнул в неизвестное
   *  место (внешний вывод, чистка экрана, свежий промпт). Следующий рендер
   *  переспросит через DSR. */
  private invalidateAnchor(): void {
    this.frameTopAbs = null;
    this.dsrPending = false;
    this.dsrTail = "";
    this.prevCursorRow = 0;
    if (this.dsrTimer) {
      clearTimeout(this.dsrTimer);
      this.dsrTimer = null;
    }
  }

  /** Парсит DSR-ответы `ESC[row;colR`. Буферит разрезанные escape между чанками.
   *  Принимает максимум один ответ (outstanding-запрос); лишние молча дропаются.
   *  Строку валидирует против `screenRows()`, отсекая неправдоподобные значения ConPTY. */
  private consumeDsrReplies(chunk: string): void {
    this.dsrTail = (this.dsrTail + chunk).slice(-80);
    const m = /\x1b\[(\d+);(\d+)R/.exec(this.dsrTail);
    if (!m) return;
    this.dsrTail = "";
    if (!this.dsrPending) return;
    this.dsrPending = false;
    const row = Number(m[1]);
    if (this.dsrTimer) {
      clearTimeout(this.dsrTimer);
      this.dsrTimer = null;
    }
    // Верх кадра = строка ответа минус визуальный ряд курсора на момент запроса.
    // `dsrQueryRow`, а не `prevCursorRow`: промежуточные рендеры могли двинуть
    // курсор, пока запрос летел.
    const top = row - this.dsrQueryRow;
    const H = this.screenRows();
    if (top >= 1 && (H === null || top <= H)) this.frameTopAbs = top;
  }

  private render(): void {
    if (!this.input.isTTY || this.isDone || this.frameSuspended) return;
    const layout = this.visibleLayout();
    const promptWidth = stringWidth(stripAnsi(this.promptStr));
    const idx = layoutIndexFor(layout, this.row, this.col);
    const vcol = visualColAt(layout, idx, this.col);
    const rowsAfter = layout.length - idx - 1;
    const ccol = (idx === 0 ? promptWidth : 0) + vcol;

    const out: string[] = [];
    // Возврат на первую строку кадра перед перерисовкой. Абсолютное
    // позиционирование (выученное одним DSR-запросом на промпт) иммунно к
    // скроллу; относительные ходы вверх — фолбэк до прихода первого ответа.
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

    this.prevCursorRow = idx;

    // Детерминированная скролл-математика: обновляем якорь для СЛЕДУЮЩЕГО рендера.
    // После записи L строк от frameTopAbs терминал скроллится, если кадр вылез за
    // низ экрана; новый верх кадра считается локально, новых DSR-запросов не надо.
    if (this.frameTopAbs !== null) {
      const H = this.screenRows();
      if (H) {
        const T = this.frameTopAbs;
        const L = layout.length;
        if (T + L - 1 > H) this.frameTopAbs = H - L + 1;
        // else: no scroll, anchor unchanged
      }
    } else if (!this.dsrPending && this.questionCb === null && this.dsrEnabled()) {
      // Один DSR-запрос на кадр, дальше якорь ведёт локальная скролл-математика.
      // В question-режиме не спрашиваем (см. dsrEnabled). Таймаут сбрасывает
      // dsrPending, чтобы неотвечающий терминал откатился на относительные ходы.
      this.dsrPending = true;
      this.dsrQueryRow = idx;
      this.output.write("\x1b[6n");
      if (this.dsrTimer) clearTimeout(this.dsrTimer);
      this.dsrTimer = setTimeout(() => {
        this.dsrPending = false;
        this.dsrTimer = null;
      }, 150);
    }
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
