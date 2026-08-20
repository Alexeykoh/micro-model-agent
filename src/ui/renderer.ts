import { pc } from "./colors";
import { FormattingStream } from "./md-formatter";
import { Spinner } from "./spinner";
import { box, divider } from "./box";
import { getTerminalWidth } from "./table";
import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";

function formatUsd(cost: number): string {
  return formatCost(cost);
}

export interface RendererOptions {
  rich?: boolean;
  spinner?: boolean;
  width?: number;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  /** "box" keeps the legacy boxed tool cards; "inline" uses opencode-like headers. */
  toolStyle?: "box" | "inline";
}

const GUTTER = "  ";

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
  private toolStyle: "box" | "inline";
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
    this.toolStyle = opts.toolStyle ?? "inline";
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
      if (this.toolStyle === "inline") {
        this.writeInlineBody(chunk);
      } else {
        this.card.body.push(chunk);
      }
    } else {
      this.out.write(chunk);
    }
  }

  /** Stream tool body lines with the gutter prefix, skipping blank lines. */
  private writeInlineBody(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      this.out.write(`${GUTTER}${line}\n`);
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

  toolStart(
    tool: string,
    args: Record<string, unknown>,
    stepContext?: string | null,
    icon?: string,
  ): void {
    this.endCard();
    this.spinner.stop();
    const summary = summarizeArgs(args);
    const step = stepContext ? ` ${pc.cyan(`← ${stepContext}`)}` : "";
    const marker = icon || toolMarker(tool);
    if (!this.rich) {
      this.out.write(
        `\n${pc.dim(marker)} ${friendlyTool(tool)}${summary ? ` ${pc.dim(summary)}` : ""}${step}\n`,
      );
      return;
    }
    this.card = { tool, args, body: [], start: Date.now() };
    if (this.toolStyle === "inline") {
      this.out.write(
        `\n${pc.dim(marker)} ${friendlyTool(tool)}${summary ? ` ${pc.dim(summary)}` : ""}${step}\n`,
      );
      if (BUSY_TOOLS.has(tool)) {
        this.spinner.start(t("ui.tool_running", { tool: friendlyTool(tool) }));
      }
      return;
    }
    this.spinner.start(
      `${pc.dim(marker)} ${friendlyTool(tool)}${summary ? ` ${pc.dim(summary)}` : ""}${step}`,
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
    provider?: string,
    model?: string,
  ): void {
    this.spinner.stop();
    const prov =
      provider && model ? `${pc.dim(`${provider}·${model}`)}` : undefined;
    if (!this.rich) {
      const parts: string[] = [];
      if (ctxDelta !== undefined && ctxDelta !== 0) {
        const deltaStr = ctxDelta > 0 ? pc.green(`+${ctxDelta}`) : pc.yellow(`${ctxDelta} ↓`);
        parts.push(`${pc.dim("ctx")} ${deltaStr}`);
      }
      if (costUsd !== undefined && costUsd > 0) {
        parts.push(`${pc.dim("cost")} ${pc.yellow(formatUsd(costUsd))}`);
      }
      if (prov) parts.push(prov);
      if (parts.length > 0) this.out.write(`${parts.join("  ")}\n`);
      return;
    }
    if (!this.card) return;
    const { tool, args, body } = this.card;
    const marker = error ? pc.red("✗") : pc.green("✓");
    let footer = `${marker} ${pc.dim(`${duration}ms`)}`;
    if (ctxDelta !== undefined && ctxDelta !== 0) {
      const deltaStr = ctxDelta > 0 ? pc.green(`+${ctxDelta}`) : pc.yellow(`${ctxDelta} ↓`);
      footer += `  ${pc.dim("ctx")} ${deltaStr}`;
    }
    if (costUsd !== undefined && costUsd > 0) {
      footer += `  ${pc.dim("cost")} ${pc.yellow(formatUsd(costUsd))}`;
    }
    if (prov) {
      footer += `  ${pc.dim("via")} ${prov}`;
    }
    if (this.toolStyle === "inline") {
      this.out.write(`${GUTTER}${footer}\n`);
      this.out.write(`${divider(this.width)}\n`);
      this.card = null;
      return;
    }
    const lines: string[] = [];
    const summary = summarizeArgs(args);
    if (summary) lines.push(pc.dim(summary));
    for (const chunk of body) {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") lines.push(line);
      }
    }
    lines.push(footer);
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
