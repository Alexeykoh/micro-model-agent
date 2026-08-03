import { pc } from "./colors";
import { FormattingStream } from "./md-formatter";
import { Spinner } from "./spinner";
import { box } from "./box";
import { getTerminalWidth } from "./table";
import { t } from "../i18n/index";

export interface RendererOptions {
  rich?: boolean;
  spinner?: boolean;
  width?: number;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export function isRichTerminal(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

/** Short human-friendly summary of tool arguments. */
export function summarizeArgs(args: Record<string, unknown>): string {
  const preferred = ["path", "file", "query", "url", "command", "name"];
  for (const key of preferred) {
    const value = args[key];
    if (typeof value === "string" && value) {
      return value.length > 60 ? `${value.slice(0, 57)}…` : value;
    }
  }
  const serialized = JSON.stringify(args);
  if (!serialized || serialized === "{}") return "";
  return serialized.length > 60 ? `${serialized.slice(0, 57)}…` : serialized;
}

function friendlyTool(tool: string): string {
  const key = `tool.friendly.${tool}`;
  const value = t(key);
  return value !== key ? value : tool;
}

/**
 * Streams agent events to the terminal. Rich mode (TTY) adds a spinner
 * and boxed tool cards; plain mode falls back to simple prefixed lines.
 * Colors come from `colors.ts`, disabled outside a TTY, in CI, or on NO_COLOR.
 */
export class Renderer {
  private rich: boolean;
  private spinner: Spinner;
  private fmt: FormattingStream;
  private out: NodeJS.WritableStream;
  private err: NodeJS.WritableStream;
  private width: number;
  private card: {
    tool: string;
    args: Record<string, unknown>;
    body: string[];
    start: number;
  } | null = null;

  constructor(opts: RendererOptions = {}) {
    this.rich = opts.rich ?? isRichTerminal();
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
    this.width = opts.width ?? getTerminalWidth();
    this.spinner = new Spinner({
      enabled: this.rich && (opts.spinner ?? true),
      stream: this.err,
      width: this.width,
    });
    this.fmt = new FormattingStream((line) => this.out.write(`${line}\n`), this.width);
  }

  /** Final answer streamed from the model (markdown-formatted). */
  text(chunk: string): void {
    this.endCard();
    this.spinner.stop();
    this.fmt.write(chunk);
  }

  /** Arbitrary status/meta text (tool output, reasoning, MoE status). */
  meta(chunk: string): void {
    this.spinner.stop();
    if (this.card) {
      this.card.body.push(chunk);
    } else {
      this.out.write(chunk);
    }
  }

  /** Dimmed reasoning stream (already colored by the agent). */
  reasoning(chunk: string): void {
    this.spinner.stop();
    this.out.write(pc.dim(chunk));
  }

  /** Model is loading / generating — show the thinking spinner. */
  thinkingStart(): void {
    this.spinner.start(t("ui.thinking"));
  }

  /** LLM call finished; clear the thinking spinner. */
  thinkingEnd(): void {
    this.spinner.stop();
  }

  toolStart(tool: string, args: Record<string, unknown>): void {
    this.endCard();
    this.spinner.stop();
    const summary = summarizeArgs(args);
    if (!this.rich) {
      this.out.write(
        `\n${pc.dim("⚙")} ${friendlyTool(tool)}${summary ? ` ${pc.dim(summary)}` : ""}\n`,
      );
      return;
    }
    this.card = { tool, args, body: [], start: Date.now() };
    this.spinner.start(
      `${pc.dim("⚙")} ${friendlyTool(tool)}${summary ? ` ${pc.dim(summary)}` : ""}`,
    );
  }

  toolEnd(_tool: string, duration: number, error?: boolean): void {
    this.spinner.stop();
    if (!this.rich) return;
    if (!this.card) return;
    const { tool, args, body } = this.card;
    const lines: string[] = [];
    const summary = summarizeArgs(args);
    if (summary) lines.push(pc.dim(summary));
    for (const chunk of body) {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") lines.push(line);
      }
    }
    const marker = error ? pc.red("✗") : pc.green("✓");
    lines.push(`${marker} ${pc.dim(`${duration}ms`)}`);
    const title = `${marker} ${friendlyTool(tool)}`;
    for (const line of box(lines, { title, width: this.width })) {
      this.out.write(`${line}\n`);
    }
    this.card = null;
  }

  /** Raw pre-formatted text (diff blocks, warnings). */
  raw(text: string): void {
    this.endCard();
    this.spinner.stop();
    this.out.write(text);
  }

  error(text: string): void {
    this.endCard();
    this.spinner.stop();
    this.err.write(`${pc.red(text)}\n`);
  }

  flush(): void {
    this.endCard();
    this.spinner.stop();
    this.fmt.flush();
  }

  private endCard(): void {
    if (!this.card) return;
    const { tool, start } = this.card;
    this.toolEnd(tool, Date.now() - start);
  }
}
