import { pc } from "./colors";
import { FormattingStream } from "./md-formatter";
import { Spinner } from "./spinner";
import {
  actionMarkFor,
  failureMark,
  glyph,
  successMark,
  formatDuration,
  toolAccent,
  type Verbosity,
} from "./theme";
import { recordLastAction } from "./action-log";

import { getTerminalWidth } from "./table";
import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";
import { getDefaultChannel, type OutputChannel } from "../output";
import { isAbsolute, relative, sep } from "path";

function formatUsd(cost: number): string {
  return formatCost(cost);
}

export interface RendererOptions {
  rich?: boolean;
  spinner?: boolean;
  width?: number;
  channel?: OutputChannel;
  /**
   * Workspace root — absolute paths inside it are shown as short relative
   * paths in tool headers (the agent already knows the root).
   */
  baseDir?: string;
  /** How much detail to render (see `docs/design/ui/STYLE.md`). */
  verbosity?: Verbosity;
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
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Tools that must NOT get a busy spinner — they block on a user prompt. */
const SPINNERLESS_TOOLS = new Set(["question", "approve"]);

/**
 * Read-only exploration tools. In quiet mode a run of these is summarized into
 * a single `│ N actions ✓` line; mutating/executing tools always stay visible.
 */
const RECON_TOOLS = new Set([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "file_info",
  "project_map",
  "chunk_query",
  "web_search",
  "web_fetch",
  "web_browse",
  "search_history",
  "recall",
  "session_info",
  "process_list",
  "process_log",
]);

interface ReconItem {
  tool: string;
  mark: string;
  label: string;
  summary: string;
  duration: number;
}

/**
 * Leading marker for every action. The style uses one marker (`◇`) for all
 * tools — categories are conveyed by the localized label, not by a glyph.
 * Kept as a function for callers that pass an explicit `icon`.
 */
export function toolMarker(_tool: string): string {
  return glyph.action;
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

/** Scalar arg keys shown as-is, in priority order, for ordinary tools. */
const GENERIC_ARG_KEYS = [
  "path",
  "file",
  "pattern",
  "query",
  "url",
  "command",
  "name",
  "task",
  "level",
  "id",
  "source",
  "step",
  "key",
  "value",
  "text",
];

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function truncateArg(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 3)}…` : text;
}

/**
 * Human-readable argument summary. Structural/action tools carry raw JSON that
 * would leak into the chat, so they get a short localized phrase instead.
 */
export function humanArgs(tool: string, args: Record<string, unknown>): string {
  if (tool === "plan") {
    const action = typeof args.action === "string" ? args.action : "";
    if (action === "update") {
      const step = args.step ?? args.stepId;
      const status = args.status;
      if (step !== undefined || status !== undefined) {
        return t("ui.plan_update", {
          step: String(step ?? "?"),
          status: String(status ?? "?"),
        });
      }
    }
    if (action === "create" && typeof args.title === "string") return args.title;
    if (action) return action;
  }
  if (tool === "todo") {
    const action = typeof args.action === "string" ? args.action : "";
    const items = Array.isArray(args.items) ? args.items.length : undefined;
    if (action && items !== undefined) return t("ui.todo_action", { action, count: String(items) });
    if (action) return action;
  }
  // Generic action-style tools (browser, project_map, lsp_check, …) carry an
  // `action` plus a few short scalars — render a phrase, not raw JSON.
  if (typeof args.action === "string" && args.action) {
    const extras = ["direction", "selector", "key", "name", "path", "url", "query", "text", "id"]
      .map((k) => (typeof args[k] === "string" && args[k] ? (args[k] as string) : undefined))
      .filter((v): v is string => Boolean(v));
    return truncateArg([args.action, ...extras].join(" "));
  }
  // Composites where a single key would drop half the meaning.
  if (tool === "move_file") {
    const from = str(args.from);
    const to = str(args.to);
    if (from && to) return truncateArg(`${from} → ${to}`);
  }
  if (tool === "mcp_call") {
    const server = str(args.server);
    const name = str(args.tool);
    if (server && name) return `${server}/${name}`;
  }
  if (tool === "remember") {
    const category = str(args.category);
    const key = str(args.key);
    const entry = str(args.entry);
    const body = key && args.value !== undefined ? `${key} = ${str(args.value)}` : key || entry;
    const phrase = [category, body].filter(Boolean).join(" · ");
    if (phrase) return truncateArg(phrase);
  }
  if (tool === "enable_tools") {
    const tags = Array.isArray(args.tags) ? args.tags.map(String).filter(Boolean) : [];
    if (tags.length) return tags.join(", ");
  }
  for (const key of GENERIC_ARG_KEYS) {
    const value = str(args[key]);
    if (value) return truncateArg(value);
  }
  return summarizeArgs(args);
}

/**
 * Localized human label for a tool. System tool names (`read_file`, `bash`, …)
 * are NEVER shown to the user in any locale — see `docs/design/ui/STYLE.md`.
 * The raw identifier is only a lookup key; when no friendly translation exists
 * we fall back to a generic localized label, never to the identifier itself.
 */
function friendlyTool(tool: string): string {
  const key = `tool.friendly.${tool}`;
  const value = t(key);
  if (value !== key) return value;
  const fallback = t("ui.action_fallback");
  return fallback !== "ui.action_fallback" ? fallback : "Action";
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
  private channel: OutputChannel;
  private width: number;
  private baseDir?: string;
  private verbosity: Verbosity;
  private card: {
    tool: string;
    args: Record<string, unknown>;
    start: number;
    label: string;
    summary: string;
    /** Leading mark for the action line (◇ or a caller-supplied icon). */
    mark: string;
    /** In quiet mode the header is deferred and folded into the footer line. */
    deferred: boolean;
    /** First non-empty body line, kept for failure reporting in quiet mode. */
    firstBody: string;
    /** Full captured body lines (for Ctrl+O reprint). */
    body: string[];
  } | null = null;
  private thoughtStarted = false;
  private thoughtStartMs = 0;
  private thoughtHeaderPrinted = false;
  /** Rotates short human labels so repeated thinking phases do not feel robotic. */
  private thinkingCount = 0;
  private thinkingLabel = "";
  private textStarted = false;
  private reconBuffer: ReconItem[] = [];
  private outputLineCount = 0;
  private outputSuppressed = false;

  constructor(opts: RendererOptions = {}) {
    this.rich = opts.rich ?? isRichTerminal();
    this.width = opts.width ?? getTerminalWidth();
    this.baseDir = opts.baseDir;
    this.verbosity = opts.verbosity ?? "normal";
    this.channel = opts.channel ?? getDefaultChannel();
    this.spinner = new Spinner({
      enabled: this.rich && (opts.spinner ?? true),
      channel: this.channel,
      width: this.width,
    });
    this.fmt = new FormattingStream(
      (line) => this.channel.writeRaw(`${line}\n`),
      this.width,
      (text) => this.channel.writeRaw(text),
      { reservedCols: 2, streamPartials: this.rich },
    );
  }

  /** Show a thinking spinner while waiting for LLM response. */
  showLoader(): void {
    this.spinner.start(t("ui.thinking"));
  }

  /** Final answer streamed from the model (markdown-formatted). */
  text(chunk: string): void {
    this.endCard();
    this.flushRecon();
    this.closeThought();
    this.spinner.stop();
    if (!this.textStarted) {
      this.textStarted = true;
      // The answer is already introduced by the REPL's divider/label; a leading
      // marker would clash with a code block that opens the response.
      this.channel.writeRaw("\n");
    }
    this.fmt.write(chunk);
  }

  /** Arbitrary status/meta text (tool output, reasoning, MoE status). */
  meta(chunk: string): void {
    this.spinner.stop();
    if (this.thoughtStarted) {
      this.writeThoughtHeader();
      this.channel.writeRaw(pc.dim(chunk));
    } else if (this.card) {
      this.writeInlineBody(chunk);
    } else {
      this.flushRecon();
      this.channel.writeRaw(chunk);
    }
  }

  /** Stream tool body lines with the gutter prefix, skipping blank lines. */
  private writeInlineBody(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      const plain = stripAnsi(line).trim();
      if (this.card) {
        if (this.card.body.length < MAX_OUTPUT_LINES) this.card.body.push(plain);
        if (!this.card.firstBody) this.card.firstBody = plain;
      }
      if (this.verbosity === "quiet") {
        // Keep the first line so a failure still has a short explanation, but
        // do not flood the chat — details are available via /verbose and Ctrl+O.
        continue;
      }
      this.outputLineCount++;
      if (this.outputLineCount > MAX_OUTPUT_LINES) {
        this.outputSuppressed = true;
        continue;
      }
      this.channel.writeRaw(`${GUTTER}${line}\n`);
    }
  }

  /** Dimmed reasoning stream (already colored by the agent). */
  reasoning(chunk: string): void {
    this.spinner.stop();
    this.flushRecon();
    this.writeThoughtHeader();
    this.channel.writeRaw(pc.dim(chunk));
  }

  /**
   * Open a thought block: `✦ <accent label> · ` — label keeps the reasoning
   * accent, the separator and the body stay dim, so the status verb never
   * blurs into the model's own words.
   */
  private writeThoughtHeader(): void {
    if (!this.thoughtStarted || this.thoughtHeaderPrinted) return;
    this.channel.writeRaw(
      `\n${pc.magenta(glyph.thinking)} ${pc.magenta(this.thinkingLabel)} ${pc.dim("·")} `,
    );
    this.thoughtHeaderPrinted = true;
  }

  /** Model is loading / generating — record start time. */
  thinkingStart(): void {
    this.flushRecon();
    this.thoughtStarted = true;
    this.thoughtStartMs = Date.now();
    this.thoughtHeaderPrinted = false;
    this.thinkingLabel = this.nextThinkingLabel();
    this.spinner.start(t("ui.thinking"));
  }

  /**
   * Rotate a few short, human labels across thinking phases. The first phase
   * always uses the canonical `ui.thinking_label` (stable in tests/screens).
   */
  private nextThinkingLabel(): string {
    const index = this.thinkingCount++;
    const key = index === 0 ? "ui.thinking_label" : `ui.thinking_label_${(index % 3) + 1}`;
    const value = t(key);
    return value !== key ? value : t("ui.thinking_label");
  }

  /** LLM call finished; print duration and close the thought block. */
  thinkingEnd(): void {
    this.spinner.stop();
    this.closeThought();
  }

  /**
   * Close an open thought block, printing its duration. Safe to call multiple
   * times — the final answer and the next tool both need the block closed so
   * the duration never lands inside the answer text.
   */
  private closeThought(): void {
    if (this.thoughtStarted && this.thoughtHeaderPrinted) {
      const duration = Date.now() - this.thoughtStartMs;
      this.channel.writeRaw(pc.dim(` ${formatDuration(duration)}\n`));
    }
    this.thoughtStarted = false;
    this.thoughtHeaderPrinted = false;
  }

  toolStart(
    tool: string,
    args: Record<string, unknown>,
    stepContext?: string | null,
    _icon?: string,
  ): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.closeThought();
    this.outputLineCount = 0;
    this.outputSuppressed = false;
    const displayArgs =
      PATH_TOOLS.has(tool) && typeof args.path === "string"
        ? { ...args, path: toDisplayPath(this.baseDir, args.path) }
        : args;
    const summary = humanArgs(tool, displayArgs);
    const label = friendlyTool(tool);
    // One glyph, colored by category — per-tool emoji icons are not used.
    const mark = actionMarkFor(tool);
    const accent = toolAccent(tool);
    const deferred = this.verbosity === "quiet";
    this.card = {
      tool,
      args,
      start: Date.now(),
      label,
      summary,
      mark,
      deferred,
      firstBody: "",
      body: [],
    };
    if (stepContext && !deferred) {
      this.channel.writeRaw(`\n${pc.dim(glyph.detail)} ${pc.cyan(stepContext)}\n`);
    }
    if (!deferred) {
      this.channel.writeRaw(
        `${mark} ${accent(label)}${summary ? ` ${pc.dim("·")} ${pc.dim(summary)}` : ""}\n`,
      );
    }
    // Busy indicator while the tool actually runs — read/write/edit/bash can
    // take seconds; without this the chat looks frozen until the footer.
    if (!SPINNERLESS_TOOLS.has(tool)) {
      this.spinner.start(`${label}${summary ? ` ${summary}` : ""}`);
    }
  }

  /** Change how much detail is rendered (used by `/verbose`). */
  setVerbosity(verbosity: Verbosity): void {
    this.verbosity = verbosity;
  }

  /** Emit a buffered run of read-only actions (quiet mode). */
  private flushRecon(): void {
    if (this.reconBuffer.length === 0) return;
    const items = this.reconBuffer;
    this.reconBuffer = [];
    if (items.length === 1) {
      const it = items[0];
      const accent = toolAccent(it.tool);
      const head = `${it.mark} ${accent(it.label)}${it.summary ? ` ${pc.dim("·")} ${pc.dim(it.summary)}` : ""}`;
      this.channel.writeRaw(`${head}  ${successMark()} ${pc.dim(formatDuration(it.duration))}\n`);
      return;
    }
    const total = items.reduce((a, b) => a + b.duration, 0);
    const label = t("ui.actions_summary", { count: String(items.length) });
    this.channel.writeRaw(
      `${pc.dim(glyph.group)} ${label} ${successMark()} ${pc.dim(`· ${formatDuration(total)}`)} ${pc.dim("· /verbose")}\n`,
    );
  }

  /** Live plan checklist — prints the plan block as-is (already colored). */
  planBlock(lines: string[]): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.flushRecon();
    for (const line of lines) {
      this.channel.writeRaw(`${line}\n`);
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
    this.fmt.flushPartialNow();
    if (!this.card) return;
    const { label, summary, mark: leadMark, deferred, firstBody } = this.card;
    const mark = error ? failureMark() : successMark();
    let tail = `${mark} ${pc.dim(formatDuration(duration))}`;
    if (ctxDelta !== undefined && ctxDelta !== 0) {
      const deltaStr = ctxDelta > 0 ? pc.green(`+${ctxDelta}`) : pc.yellow(`${ctxDelta} ↓`);
      tail += `  ${pc.dim("ctx")} ${deltaStr}`;
    }
    if (costUsd !== undefined && costUsd > 0) {
      tail += `  ${pc.dim("cost")} ${pc.yellow(formatUsd(costUsd))}`;
    }
    if (deferred) {
      // Quiet mode: fold the deferred header into a single action line.
      // A run of successful read-only tools is buffered and summarized.
      if (!error && RECON_TOOLS.has(this.card.tool)) {
        this.reconBuffer.push({
          tool: this.card.tool,
          mark: leadMark,
          label,
          summary,
          duration,
        });
        this.recordLast(label, summary, error, duration);
        this.card = null;
        return;
      }
      this.flushRecon();
      const head = `${leadMark} ${toolAccent(this.card.tool)(label)}${
        summary ? ` ${pc.dim("·")} ${pc.dim(summary)}` : ""
      }`;
      this.channel.writeRaw(`${head}  ${tail}\n`);
      if (error && firstBody) {
        const soft = firstBody.startsWith("⚠");
        const color = soft ? pc.yellow : pc.red;
        this.channel.writeRaw(`${GUTTER}${pc.dim(glyph.detail)} ${color(firstBody)}\n`);
      }
    } else {
      const footer = `${GUTTER}${tail}`;
      this.channel.writeRaw(`${footer}\n`);
      if (this.outputSuppressed) {
        this.channel.writeRaw(
          `${GUTTER}${pc.dim(`... (${this.outputLineCount - MAX_OUTPUT_LINES} more lines)`)}\n`,
        );
      }
    }
    this.recordLast(label, summary, error, duration);
    this.card = null;
  }

  /** Remember the action for `Ctrl+O` reprint (survives the run). */
  private recordLast(
    label: string,
    summary: string,
    error: boolean | undefined,
    duration: number,
  ): void {
    const firstBody = this.card?.firstBody ?? "";
    const status: "ok" | "warn" | "error" = !error
      ? "ok"
      : firstBody.startsWith("⚠")
        ? "warn"
        : "error";
    recordLastAction({
      tool: this.card?.tool ?? "",
      label,
      args: summary,
      status,
      durationMs: duration,
      body: this.card?.body ?? [],
    });
  }

  /** Raw pre-formatted text (diff blocks, warnings). */
  raw(text: string): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.flushRecon();
    this.channel.writeRaw(text);
  }

  error(text: string): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.flushRecon();
    this.channel.writeRaw(`${failureMark()} ${pc.red(text)}\n`, "stderr");
  }

  flush(): void {
    this.endCard();
    this.flushRecon();
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.fmt.flush();
    this.textStarted = false;
  }

  /** Footer with model, provider, and total duration. */
  footer(model: string, provider: string, durationMs: number): void {
    this.flushRecon();
    this.channel.writeRaw(
      `\n${pc.dim(glyph.metric)} ${model} · ${provider} · ${pc.dim(formatDuration(durationMs))}\n`,
    );
  }

  private endCard(): void {
    if (!this.card) return;
    const { tool, start } = this.card;
    this.toolEnd(tool, Date.now() - start);
  }
}
