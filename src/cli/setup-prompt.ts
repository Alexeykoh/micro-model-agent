/**
 * Минимальный строчный промпт для визарда настройки.
 *
 * Визард осознанно НЕ использует `readline.createInterface` (Bun оставляет stdin
 * в состоянии, где raw-режимный LineEditor REPL не получает keypress — фриз
 * первого запуска) и не LineEditor REPL (расшаривание живого редактора с
 * работающим REPL рассинхронизирует ввод и состояние терминала). Вместо этого
 * читает stdin в COOKED-режиме: эхо/правка — на терминале, мы лишь копим байты
 * до перевода строки и резолвим pending-вопрос. Без raw-режима, декодинга
 * клавиш и DSR-запросов курсора.
 *
 * Жизненный цикл явный: `new SetupPrompt()` аттачит, `close()` деттачит и ставит
 * stdin на паузу, оставляя его чистым для захвата REPL.
 */
/** Вход промпта: вопрос + колбэк ответа. */
export interface PromptInput {
  question(query: string, cb: (answer: string) => void): void;
}

type StdinLike = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  pause?: () => void;
};

/** Cooked-режимный промпт визарда: эхо/правка на терминале, мы копим до newline. */
export class SetupPrompt implements PromptInput {
  private pending: ((answer: string) => void) | null = null;
  private buffer = "";
  private closed = false;
  private readonly onData: (buf: Buffer) => void;

  constructor(
    private readonly input: StdinLike = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    // Cooked-режим: правка строки и эхо — на консоли.
    if (typeof this.input.setRawMode === "function") this.input.setRawMode(false);
    this.onData = (buf: Buffer) => this.consume(buf.toString("utf-8"));
    this.input.on("data", this.onData);
    this.input.resume?.();
  }

  question(query: string, cb: (answer: string) => void): void {
    if (this.closed) return;
    this.buffer = "";
    this.pending = cb;
    this.output.write(query);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = null;
    this.input.removeListener("data", this.onData);
    this.input.pause?.();
  }

  private consume(text: string): void {
    if (!this.pending || this.closed) return;
    this.buffer += text;
    const idx = this.buffer.search(/[\r\n]/);
    if (idx === -1) return;
    const answer = this.buffer.slice(0, idx);
    this.buffer = "";
    const cb = this.pending;
    this.pending = null;
    // TTY сам эхует Enter переводом строки; дописываем его только пайпам.
    if (!(this.output as { isTTY?: boolean }).isTTY) this.output.write("\n");
    cb(answer);
  }
}
