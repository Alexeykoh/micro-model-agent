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

/** Compact context bar for the spinner's extra text: "ctx: 42% ████░░░░░░  compactions: 1  quality: 63%" */
export function formatContextBarCompact(
  tokens: number,
  limit: number,
  compactions: number,
  quality: number,
): string {
  const pct = Math.min(100, Math.round((tokens / limit) * 100));
  const barLen = 8;
  const filled = Math.round((pct / 100) * barLen);
  const bar =
    pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
  const pctColor = pct >= 75 ? pc.yellow : pc.dim;
  const qColor = quality >= 70 ? pc.green : quality >= 40 ? pc.yellow : pc.red;
  return `ctx: ${pctColor(`${pct}%`)} ${bar}  compactions: ${compactions}  quality: ${qColor(`${quality}%`)}`;
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
  private contextInfoFn?: () => string;

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
    this.fmt = new FormattingStream(
      (line) => this.out.write(`${line}\n`),
      this.width,
    );
  }

  /** Set a callback that returns the context info string for the spinner's extra text. */
  setContextInfoProvider(fn: () => string): void {
    this.contextInfoFn = fn;
  }

  /** Refresh the spinner's extra text with current context info. */
  refreshContextBar(): void {
    if (this.contextInfoFn && this.spinner.running) {
      this.spinner.setExtra(this.contextInfoFn());
    }
  }

  /** Final answer streamed from the model (markdown-formatted). */
  text(chunk: string): void {
    this.endCard();
    this.spinner.setTopBar(false);
    this.fmt.write(chunk);
  }

  /** Arbitrary status/meta text (tool output, reasoning, MoE status). */
  meta(chunk: string): void {
    if (this.card) {
      this.card.body.push(chunk);
    } else {
      this.out.write(chunk);
    }
  }

  /** Dimmed reasoning stream (already colored by the agent). */
  reasoning(chunk: string): void {
    this.out.write(pc.dim(chunk));
  }

  /** Model is loading / generating — show the thinking spinner in top-bar mode. */
  thinkingStart(): void {
    this.spinner.setTopBar(true);
    this.spinner.start(t("ui.thinking"));
    this.refreshContextBar();
  }

  /** LLM call finished; switch spinner to non-animated context bar (top-bar). */
  thinkingEnd(): void {
    this.spinner.setMessage("");
    this.refreshContextBar();
  }

  toolStart(tool: string, args: Record<string, unknown>): void {
    this.endCard();
    this.spinner.setTopBar(false);
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

  toolEnd(
    _tool: string,
    duration: number,
    error?: boolean,
    ctxDelta?: number,
  ): void {
    this.spinner.stop();
    if (!this.rich) {
      if (ctxDelta !== undefined && ctxDelta !== 0) {
        const deltaStr =
          ctxDelta > 0 ? pc.green(`+${ctxDelta}`) : pc.yellow(`${ctxDelta} ↓`);
        this.out.write(`${pc.dim("ctx")} ${deltaStr}\n`);
      }
      return;
    }
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
    let footer = `${marker} ${pc.dim(`${duration}ms`)}`;
    if (ctxDelta !== undefined && ctxDelta !== 0) {
      const deltaStr =
        ctxDelta > 0 ? pc.green(`+${ctxDelta}`) : pc.yellow(`${ctxDelta} ↓`);
      footer += `  ${pc.dim("ctx")} ${deltaStr}`;
    }
    lines.push(footer);
    const title = `${marker} ${friendlyTool(tool)}`;
    for (const line of box(lines, { title, width: this.width })) {
      this.out.write(`${line}\n`);
    }
    this.card = null;

    // After tool card, restore spinner to top-bar context display
    this.spinner.setTopBar(true);
    this.spinner.setMessage("");
    this.refreshContextBar();
    // Don't start the timer — just show context bar on demand via refreshContextBar
  }

  /** Raw pre-formatted text (diff blocks, warnings). */
  raw(text: string): void {
    this.endCard();
    this.spinner.setTopBar(false);
    this.spinner.stop();
    this.out.write(text);
  }

  error(text: string): void {
    this.endCard();
    this.spinner.setTopBar(false);
    this.spinner.stop();
    this.err.write(`${pc.red(text)}\n`);
  }

  flush(): void {
    this.endCard();
    this.spinner.setTopBar(false);
    this.spinner.stop();
    this.fmt.flush();
  }

  private endCard(): void {
    if (!this.card) return;
    const { tool, start } = this.card;
    this.toolEnd(tool, Date.now() - start);
  }
}
