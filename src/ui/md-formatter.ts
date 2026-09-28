// Markdown-форматтер чата: стриминг строк, подсветка кода, таблицы (см. STYLE.md).
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
    code = code.replace(ATTR, (_m, attr, val) => `${pc.yellow(attr)}=${pc.green(`"${val}"`)}`);
    code = code.replace(TAG, (_m, tag) => `<${pc.cyan(tag)}`);
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

/** Стриминговый форматтер markdown в терминальные строки. */
export class FormattingStream {
  private buffer = "";
  private inCodeBlock = false;
  private codeLang = "";
  private codeLines: string[] = [];
  private tableBuffer: string[] = [];
  private onWrite: (text: string) => void;
  private onRawWrite: (text: string) => void;
  private width: number;
  /** Колонок сырого партиала, показанного сейчас в терминале. */
  private partialWritten = 0;
  /** Сколько символов pending-строки уже стримлено сырьём. */
  private streamedChars = 0;
  /** Колонок зарезервировано слева (префикс вызывающего), чтобы партиал не враппился. */
  private reservedCols: number;
  /**
   * Стрим текущей (ещё не завершённой переводом строки) строки сырьём для живого
   * фидбэка. По умолчанию выкл; офлайн-вызывающие используют `formatMarkdown`.
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
   * Стримит pending-строку сырьём для real-time фидбэка; форматированная строка
   * заменяет её по приходу перевода строки.
   *
   * Замена — ОТНОСИТЕЛЬНЫМ движением курсора (`\x1b[<cols>D`), корректным лишь
   * пока стримленный текст сидит на одной визуальной строке, с которой начал.
   * Если партиал шире терминала, он враппится и каждый относительный сдвиг бьёт
   * мимо — та самая битая выдача после рефактора вывода 1.0.0 (потерянные/
   * переставленные символы, потёкшие маркеры, ломаные таблицы). Поэтому стрим
   * замирает на последнем влезшем чанке, а строка рендерится по завершении.
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
      // Откат поверх стримленного партиала + стереть хвост, оставшийся от более
      // короткой форматированной замены, до рендера строки вызывающим.
      this.onRawWrite(`\x1b[${this.partialWritten}D\x1b[K`);
      this.partialWritten = 0;
    }
    this.streamedChars = 0;
  }

  /** Есть ли показанный партиал или необработанный буфер. @internal */
  hasPartial(): boolean {
    return this.partialWritten > 0 || this.buffer.length > 0 || this.tableBuffer.length > 0;
  }

  /**
   * Финализирует показанный сырой партиал, чтобы следующая запись началась с новой строки.
   * Терминируется только уже стримленный партиал (одиночный перевод строки через
   * `onRawWrite`); pending-буфер таблицы сбрасывается. Открытый кодовый блок
   * осознанно не трогается: закрытие здесь сделало бы настоящий закрывающий fence
   * похожим на новый открывающий и испортило бы всю прозу дальше. Блок эмитит
   * финальный `flush()`. Идемпотентно.
   */
  flushPartialNow(): void {
    if (this.partialWritten > 0) {
      // Строка уже на экране сырьём; терминируем как есть (может быть оборвана
      // посреди markdown) и дропаем, чтобы не отрендерить дважды.
      this.onRawWrite("\n");
      this.partialWritten = 0;
      this.streamedChars = 0;
      this.buffer = "";
    } else if (this.buffer.length > 0 && !this.inCodeBlock) {
      // Не стримлено (plain-режим) — рендерим pending-строку сейчас.
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
        // Закрывающий fence в EOF без trailing newline: считаем закрытием, а не
        // контентом кода (иначе "```" потечёт в блок).
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
        // Pending-таблица не должна эмититься ПОСЛЕ идущего за ней кодового блока:
        // сбрасываем до входа в fence.
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
      // Без рамки: только dim-ярлык языка и левый гуттер. Коробочные кодовые
      // блоки запрещены стилем чата (docs/design/ui/STYLE.md).
      if (this.codeLang) this.onWrite(pc.dim(`  ${this.codeLang}`));
      for (const l of highlighted.split("\n")) {
        this.onWrite(pc.dim(`${glyph.group} `) + l);
      }
    }
    this.codeLines = [];
    this.codeLang = "";
  }

  private formatLine(line: string): string {
    const result = line;

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
      const short = url.length > 80 ? `${url.slice(0, 77)}…` : url;
      return `${pc.cyan(label)} ${pc.dim(`(${short})`)}`;
    });

    result = result.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)]);
    return result;
  }
}

/** Форматирует markdown-текст целиком в терминальные строки. */
export function formatMarkdown(text: string): string {
  const lines: string[] = [];
  const stream = new FormattingStream((l) => lines.push(l));
  stream.write(text);
  stream.flush();
  return lines.join("\n");
}

/** Форматирует ошибку (красный префикс из i18n). */
export function formatError(text: string): string {
  return pc.red(pc.bold(t("ui.error_prefix")) + text);
}

/** Форматирует успех (зелёный префикс из i18n). */
export function formatSuccess(text: string): string {
  return pc.green(pc.bold(t("ui.success_prefix")) + text);
}

/** Форматирует предупреждение (жёлтый префикс из i18n). */
export function formatWarning(text: string): string {
  return pc.yellow(pc.bold(t("ui.warning_prefix")) + text);
}
