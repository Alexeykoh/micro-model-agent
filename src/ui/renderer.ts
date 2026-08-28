import { pc } from "./colors";
import { FormattingStream } from "./md-formatter";
import { Spinner } from "./spinner";

import { getTerminalWidth } from "./table";
import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";
import { isAbsolute, relative, sep } from "path";

function formatUsd(cost: number): string {
  return formatCost(cost);
}

export interface RendererOptions {
  rich?: boolean;
  spinner?: boolean;
  width?: number;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  /**
   * Workspace root — absolute paths inside it are shown as short relative
   * paths in tool headers (the agent already knows the root).
   */
  baseDir?: string;
}

/** Tools whose `path` argument is shown in the header. */
const PATH_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
  "create_dir",
  "move_file",
  "list_dir",
  "file_info",
]);

function toDisplayPath(baseDir: string | undefined, p: string): string {
  if (!baseDir || !isAbsolute(p)) return p;
  const rel = relative(baseDir, p);
  // Outside baseDir (../ prefix) or another drive (absolute result) → keep as-is.
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel.split(sep).join("/");
}

const GUTTER = "  ";
const MAX_OUTPUT_LINES = 50;

/** Tools that show a busy spinner while running (inline mode). */
const BUSY_TOOLS = new Set(["lsp_check"]);

/** opencode-like leading marker per tool category. */
export function toolMarker(tool: string): string {
  switch (tool) {
    case "write_file":
    case "edit_file":
    case "create_dir":
    case "move_file":
    case "delete_file":
      return "←";
    case "read_file":
    case "list_dir":
    case "file_info":
      return "→";
    case "glob":
    case "grep":
      return "✱";
    case "bash":
      return "$";
    default:
      return "⚙";
  }
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
 * Streams agent events to the terminal. Rich mode (TTY) adds a spinner;
 * plain mode falls back to simple prefixed lines.
 * Colors come from `colors.ts`, disabled outside a TTY, in CI, or on NO_COLOR.
 */
export class Renderer {
  private rich: boolean;
  private spinner: Spinner;
  private fmt: FormattingStream;
  private out: NodeJS.WritableStream;
  private err: NodeJS.WritableStream;
  private width: number;
  private baseDir?: string;
  private card: {
    tool: string;
    args: Record<string, unknown>;
    start: number;
  } | null = null;
  private thoughtStarted = false;
  private thoughtStartMs = 0;
  private thoughtHeaderPrinted = false;
  private textStarted = false;
  private outputLineCount = 0;
  private outputSuppressed = false;

  constructor(opts: RendererOptions = {}) {
    this.rich = opts.rich ?? isRichTerminal();
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
    this.width = opts.width ?? getTerminalWidth();
    this.baseDir = opts.baseDir;
    this.spinner = new Spinner({
      enabled: this.rich && (opts.spinner ?? true),
      stream: this.err,
      width: this.width,
    });
    this.fmt = new FormattingStream((line) => this.out.write(`${line}\n`), this.width);
  }

  /** Show a thinking spinner while waiting for LLM response. */
  showLoader(): void {
    this.spinner.start("thinking");
  }

  /** Final answer streamed from the model (markdown-formatted). */
  text(chunk: string): void {
    this.endCard();
    this.spinner.stop();
    if (!this.textStarted) {
      this.textStarted = true;
      this.out.write(`\n${pc.dim("-")} `);
    }
    this.fmt.write(chunk);
  }

  /** Arbitrary status/meta text (tool output, reasoning, MoE status). */
  meta(chunk: string): void {
    this.spinner.stop();
    if (this.thoughtStarted) {
      if (!this.thoughtHeaderPrinted) {
        this.out.write(`\n${pc.dim("→")} Thought: `);
        this.thoughtHeaderPrinted = true;
      }
      this.out.write(pc.dim(chunk));
    } else if (this.card) {
      this.writeInlineBody(chunk);
    } else {
      this.out.write(chunk);
    }
  }

  /** Stream tool body lines with the gutter prefix, skipping blank lines. */
  private writeInlineBody(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      this.outputLineCount++;
      if (this.outputLineCount > MAX_OUTPUT_LINES) {
        this.outputSuppressed = true;
        continue;
      }
      this.out.write(`${GUTTER}${line}\n`);
    }
  }

  /** Dimmed reasoning stream (already colored by the agent). */
  reasoning(chunk: string): void {
    this.spinner.stop();
    if (this.thoughtStarted && !this.thoughtHeaderPrinted) {
      this.out.write(`\n${pc.dim("→")} Thought: `);
      this.thoughtHeaderPrinted = true;
    }
    this.out.write(pc.dim(chunk));
  }

  /** Model is loading / generating — record start time. */
  thinkingStart(): void {
    this.thoughtStarted = true;
    this.thoughtStartMs = Date.now();
    this.thoughtHeaderPrinted = false;
  }

  /** LLM call finished; print duration and close the thought block. */
  thinkingEnd(): void {
    this.spinner.stop();
    if (this.thoughtStarted && this.thoughtHeaderPrinted) {
      const duration = Date.now() - this.thoughtStartMs;
      this.out.write(pc.dim(` ${duration}ms\n`));
    }
    this.thoughtStarted = false;
    this.thoughtHeaderPrinted = false;
  }

  toolStart(
    tool: string,
    args: Record<string, unknown>,
    stepContext?: string | null,
    icon?: string,
  ): void {
    this.endCard();
    this.spinner.stop();
    this.outputLineCount = 0;
    this.outputSuppressed = false;
    const displayArgs =
      PATH_TOOLS.has(tool) && typeof args.path === "string"
        ? { ...args, path: toDisplayPath(this.baseDir, args.path) }
        : args;
    const summary = summarizeArgs(displayArgs);
    const marker = icon || toolMarker(tool);
    this.card = { tool, args, start: Date.now() };
    if (stepContext) {
      this.out.write(`\n${pc.dim("↓")} ${pc.cyan(stepContext)}\n`);
    }
    this.out.write(
      `${pc.dim(marker)} ${friendlyTool(tool)}${summary ? ` ${pc.dim(summary)}` : ""}\n`,
    );
  }

  /** Live plan checklist — prints the plan block as-is (already colored). */
  planBlock(lines: string[]): void {
    this.endCard();
    this.spinner.stop();
    for (const line of lines) {
      this.out.write(`${line}\n`);
    }
  }

  toolEnd(
    _tool: string,
    duration: number,
    error?: boolean,
    ctxDelta?: number,
    costUsd?: number,
  ): void {
    this.spinner.stop();
    if (!this.card) return;
    const marker = error ? pc.red("✗") : pc.green("✓");
    let footer = `${GUTTER}${marker} ${pc.dim(`${duration}ms`)}`;
    if (ctxDelta !== undefined && ctxDelta !== 0) {
      const deltaStr = ctxDelta > 0 ? pc.green(`+${ctxDelta}`) : pc.yellow(`${ctxDelta} ↓`);
      footer += `  ${pc.dim("ctx")} ${deltaStr}`;
    }
    if (costUsd !== undefined && costUsd > 0) {
      footer += `  ${pc.dim("cost")} ${pc.yellow(formatUsd(costUsd))}`;
    }
    this.out.write(`${footer}\n`);
    if (this.outputSuppressed) {
      this.out.write(`${GUTTER}${pc.dim(`... (${this.outputLineCount - MAX_OUTPUT_LINES} more lines)`)}\n`);
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
    this.textStarted = false;
  }

  /** Footer with model, provider, and total duration. */
  footer(model: string, provider: string, durationMs: number): void {
    this.out.write(`\n${pc.dim("▣")} ${model} · ${provider} · ${pc.dim(`${durationMs}ms`)}\n`);
  }

  private endCard(): void {
    if (!this.card) return;
    const { tool, start } = this.card;
    this.toolEnd(tool, Date.now() - start);
  }
}
