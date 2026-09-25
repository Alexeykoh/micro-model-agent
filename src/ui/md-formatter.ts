import { pc } from "./colors";
import stringWidth from "string-width";
import { t } from "../i18n/index";
import { formatTable, getTerminalWidth } from "./table";
import { glyph } from "./theme";

const KW =
  /\b(import|export|from|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|type|enum|namespace|module|declare|abstract|async|await|yield|throw|try|catch|finally|typeof|instanceof|in|of|as|is|keyof|readonly|static|private|public|protected|get|set|constructor|this|super|void|never|any|unknown|boolean|string|number|symbol|object|true|false|null|undefined|default)\b/g;
const STRING = /('[^']*'|"[^"]*"|`[^`]*`)/g;
const COMMENT = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g;
const NUMBER = /\b(\d+\.?\d*)\b/g;
const TAG = /<\/?([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9-]*)/g;
const ATTR = /\b([a-zA-Z-]+=)"([^"]*)"/g;

function highlight(code: string, lang: string): string {
  if (lang === "html" || lang === "xml" || lang === "svg") {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(ATTR, (_m, attr, val) => pc.yellow(attr) + "=" + pc.green('"' + val + '"'));
    code = code.replace(TAG, (_m, tag) => "<" + pc.cyan(tag));
  } else if (lang === "css" || lang === "scss" || lang === "less") {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(STRING, (m) => pc.green(m));
    code = code.replace(NUMBER, (m) => pc.yellow(m));
  } else if (lang === "bash" || lang === "sh" || lang === "shell" || lang === "zsh") {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(STRING, (m) => pc.green(m));
  } else if (lang === "json") {
    code = code.replace(STRING, (m) => pc.green(m));
    code = code.replace(NUMBER, (m) => pc.yellow(m));
  } else {
    // js, ts, jsx, tsx, and fallback
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(STRING, (m) => pc.green(m));
    code = code.replace(KW, (m) => pc.magenta(m));
    code = code.replace(NUMBER, (m) => pc.yellow(m));
  }

  return code;
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const pipes = trimmed.match(/\|/g);
  return (pipes?.length ?? 0) >= 2;
}

function isHorizontalRule(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim());
}

export class FormattingStream {
  private buffer = "";
  private inCodeBlock = false;
  private codeLang = "";
  private codeLines: string[] = [];
  private tableBuffer: string[] = [];
  private onWrite: (text: string) => void;
  private onRawWrite: (text: string) => void;
  private width: number;
  /** Display columns of the raw partial currently shown on the terminal. */
  private partialWritten = 0;
  /** How many chars of the pending line have already been streamed raw. */
  private streamedChars = 0;
  /** Columns reserved on the left (caller prefix) so a partial never wraps. */
  private reservedCols: number;
  /**
   * Stream the current (not-yet-newline-terminated) line raw for live
   * feedback. Off by default — offline callers use `formatMarkdown`.
   */
  private streamPartials: boolean;

  constructor(
    onWrite: (text: string) => void,
    width?: number,
    onRawWrite?: (text: string) => void,
    opts: { reservedCols?: number; streamPartials?: boolean } = {},
  ) {
    this.onWrite = onWrite;
    this.onRawWrite = onRawWrite ?? onWrite;
    this.width = width ?? getTerminalWidth();
    this.reservedCols = opts.reservedCols ?? 0;
    this.streamPartials = opts.streamPartials ?? false;
  }

  write(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.emitPartialRewind();
      this.processLine(line);
    }
    if (this.buffer.length > 0 && !this.inCodeBlock) {
      this.streamPartial();
    }
  }

  /**
   * Stream the pending line raw for real-time feedback; the formatted line
   * replaces it once the newline arrives.
   *
   * The replacement uses a RELATIVE cursor move (`\x1b[<cols>D`), which is only
   * correct while the streamed text stays on the single visual line it started
   * on. If the partial would exceed the terminal width it wraps and every
   * relative move lands in the wrong place — the garbled output observed after
   * the 1.0.0 output refactor (missing/swapped characters, leaked markers,
   * broken tables). So streaming freezes at the last chunk that fits and the
   * line is rendered when it completes.
   */
  private streamPartial(): void {
    if (!this.streamPartials) return;
    const available = Math.max(1, this.width - this.reservedCols);
    if (stringWidth(this.buffer) > available) return;
    const delta = this.buffer.slice(this.streamedChars);
    if (!delta) return;
    this.onRawWrite(delta);
    this.streamedChars = this.buffer.length;
    this.partialWritten = stringWidth(this.buffer);
  }

  private emitPartialRewind(): void {
    if (this.partialWritten > 0) {
      // Move back over the streamed partial and erase any tail left by a
      // shorter formatted replacement before the caller renders the line.
      this.onRawWrite(`\x1b[${this.partialWritten}D\x1b[K`);
      this.partialWritten = 0;
    }
    this.streamedChars = 0;
  }

  /** True when there is displayed partial output or unprocessed buffered text. @internal */
  hasPartial(): boolean {
    return this.partialWritten > 0 || this.buffer.length > 0 || this.tableBuffer.length > 0;
  }

  /**
   * Finalize a displayed raw partial so the next write starts on a fresh line.
   * Only the already-streamed partial is terminated (with a single newline via
   * `onRawWrite`); any pending table buffer is flushed. An open code block is
   * intentionally left untouched — closing it here would make the real closing
   * fence look like a new opening fence and corrupt all following prose. The
   * code block is emitted by the final `flush()`. Idempotent.
   */
  flushPartialNow(): void {
    if (this.partialWritten > 0) {
      // The line is already on screen raw; terminate it as-is (it may be
      // interrupted mid-markdown) and drop it so it is not rendered twice.
      this.onRawWrite("\n");
      this.partialWritten = 0;
      this.streamedChars = 0;
      this.buffer = "";
    } else if (this.buffer.length > 0 && !this.inCodeBlock) {
      // Never streamed (plain mode) — render the pending line now.
      const line = this.buffer;
      this.buffer = "";
      this.streamedChars = 0;
      this.onWrite(this.formatLine(line));
    }
    if (this.tableBuffer.length > 0) {
      this.flushTable();
    }
  }

  flush(): void {
    if (this.tableBuffer.length > 0) {
      this.flushTable();
    }
    if (this.inCodeBlock) {
      if (this.buffer.length > 0) {
        // A closing fence at EOF has no trailing newline; treat it as the
        // close, not as code content (otherwise "```" leaks into the block).
        if (this.buffer.trim().startsWith("```")) {
          this.buffer = "";
        } else {
          this.codeLines.push(this.buffer);
          this.buffer = "";
        }
      }
      if (this.codeLines.length > 0) {
        this.emitCodeBlock();
      }
      this.streamedChars = 0;
      return;
    }
    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = "";
      this.emitPartialRewind();
      this.onWrite(this.formatLine(line));
    }
    this.streamedChars = 0;
  }

  private processLine(line: string): void {
    if (line.trim() === "```" || line.trim().startsWith("```")) {
      if (this.inCodeBlock) {
        this.emitCodeBlock();
      } else {
        // A pending table must not be emitted AFTER the code block that
        // follows it: flush it before entering the fence.
        if (this.tableBuffer.length > 0) this.flushTable();
        this.inCodeBlock = true;
        this.codeLang = line.trim().slice(3).trim();
        this.codeLines = [];
      }
      return;
    }

    if (this.inCodeBlock) {
      this.codeLines.push(line);
      return;
    }

    if (isTableRow(line)) {
      this.tableBuffer.push(line);
      return;
    }

    if (this.tableBuffer.length > 0) {
      this.flushTable();
    }

    this.onWrite(this.formatLine(line));
  }

  private flushTable(): void {
    const lines = this.tableBuffer;
    this.tableBuffer = [];
    const hasSeparator = lines.length >= 2 && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1].trim());
    if (hasSeparator) {
      for (const l of formatTable(lines, { maxWidth: this.width })) {
        this.onWrite(l);
      }
    } else {
      for (const l of lines) {
        this.onWrite(this.formatLine(l));
      }
    }
  }

  private emitCodeBlock(): void {
    this.inCodeBlock = false;
    if (this.codeLines.length > 0) {
      const code = this.codeLines.join("\n");
      const highlighted = highlight(code, this.codeLang);
      // No frame: a dim language label and a left gutter only. Boxed code
      // blocks are banned by the chat style (docs/design/ui/STYLE.md).
      if (this.codeLang) this.onWrite(pc.dim(`  ${this.codeLang}`));
      for (const l of highlighted.split("\n")) {
        this.onWrite(pc.dim(`${glyph.group} `) + l);
      }
    }
    this.codeLines = [];
    this.codeLang = "";
  }

  private formatLine(line: string): string {
    let result = line;

    const heading = result.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = this.formatInline(heading[2]);
      if (level === 1) return pc.cyan(pc.bold(pc.underline(content)));
      return pc.cyan(pc.bold(content));
    }

    if (isHorizontalRule(result)) {
      return pc.dim("─".repeat(Math.max(0, Math.min(this.width, 60))));
    }

    const quote = result.match(/^(>+)\s?(.*)$/);
    if (quote) {
      const depth = Math.min(quote[1].length, 4);
      const marker = pc.dim("▍".repeat(depth));
      return `${marker} ${this.formatInline(quote[2])}`;
    }

    const checkbox = result.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) {
      const checked = checkbox[1].toLowerCase() === "x";
      const mark = checked ? pc.green("✓") : pc.dim("☐");
      return `  ${mark} ${this.formatInline(checkbox[2])}`;
    }

    const ordered = result.match(/^(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      return ` ${pc.yellow(ordered[1])}. ${this.formatInline(ordered[2])}`;
    }

    const bullet = result.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      return ` ${pc.dim("•")} ${this.formatInline(bullet[1])}`;
    }

    return this.formatInline(result);
  }

  private formatInline(text: string): string {
    const codeSpans: string[] = [];
    let result = text.replace(/`([^`]+)`/g, (_m, c) => {
      codeSpans.push(pc.yellow(c));
      return `\u0000${codeSpans.length - 1}\u0000`;
    });

    // `***text***` (bold+italic) до одиночных `**`/`*`, иначе вложенность
    // рвётся и во вложении остаётся висящая звёздочка.
    result = result.replace(/\*\*\*(.+?)\*\*\*/g, (_, s) => pc.bold(pc.italic(s)));
    result = result.replace(/\*\*(.+?)\*\*/g, (_, s) => pc.bold(s));
    result = result.replace(/~~(.+?)~~/g, (_, s) => pc.strikethrough(s));
    result = result.replace(/\*([^*]+)\*/g, (_, s) => pc.italic(s));
    result = result.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, (_m, pre, s) => pre + pc.italic(s));
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const short = url.length > 80 ? url.slice(0, 77) + "…" : url;
      return `${pc.cyan(label)} ${pc.dim(`(${short})`)}`;
    });

    result = result.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)]);
    return result;
  }
}

export function formatMarkdown(text: string): string {
  const lines: string[] = [];
  const stream = new FormattingStream((l) => lines.push(l));
  stream.write(text);
  stream.flush();
  return lines.join("\n");
}

export function formatError(text: string): string {
  return pc.red(pc.bold(t("ui.error_prefix")) + text);
}

export function formatSuccess(text: string): string {
  return pc.green(pc.bold(t("ui.success_prefix")) + text);
}

export function formatWarning(text: string): string {
  return pc.yellow(pc.bold(t("ui.warning_prefix")) + text);
}
