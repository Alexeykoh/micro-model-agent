/**
 * Minimal line prompt for the setup wizard.
 *
 * The wizard deliberately does NOT use `readline.createInterface` (Bun leaves
 * stdin in a state where the REPL's raw-mode LineEditor never receives
 * keypress events — the first-run freeze) nor the REPL's LineEditor (sharing
 * the live editor with the running REPL desynchronises input and terminal
 * state). Instead it reads stdin in COOKED mode: the terminal does its own
 * echo/editing, we only accumulate bytes until a newline and resolve the
 * pending question. No raw mode, no keypress decoding, no DSR cursor queries.
 *
 * Lifecycle is explicit: `new SetupPrompt()` attaches, `close()` detaches and
 * pauses stdin, leaving it clean for the REPL to take over.
 */
export interface PromptInput {
  question(query: string, cb: (answer: string) => void): void;
}

type StdinLike = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => void;
  resume?: () => void;
  pause?: () => void;
};

export class SetupPrompt implements PromptInput {
  private pending: ((answer: string) => void) | null = null;
  private buffer = "";
  private closed = false;
  private readonly onData: (buf: Buffer) => void;

  constructor(
    private readonly input: StdinLike = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    // Cooked mode: the console handles line editing and echo.
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
    // A TTY already echoes the Enter as a newline; only piped input needs one.
    if (!(this.output as { isTTY?: boolean }).isTTY) this.output.write("\n");
    cb(answer);
  }
}
