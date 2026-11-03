// Рендерер чата: события агента в терминальные строки по STYLE.md.
import { pc } from "./colors";
import { FormattingStream } from "./md-formatter";
import { Spinner } from "./spinner";
import { failureMark, glyph, successMark, formatDuration, type Verbosity } from "./theme";
import { friendlyTool, humanArgs, isPathTool, toDisplayPath } from "./renderer-args";
import { BodyStream, GUTTER } from "./renderer-body";
import { recordCard, type CardState } from "./renderer-card";
import { actionHead, footerTail } from "./renderer-format";
import { QuietFlow } from "./renderer-quiet";
import { ThoughtBlock } from "./renderer-thought";

import { getTerminalWidth } from "./table";
import { t } from "../i18n/index";
import { getDefaultChannel, type OutputChannel } from "../output";

export { humanArgs, summarizeArgs, toolMarker } from "./renderer-args";

/** Опции рендерера: rich-TTY, спиннер, ширина, канал, корень, болтливость. */
export interface RendererOptions {
  rich?: boolean;
  spinner?: boolean;
  width?: number;
  channel?: OutputChannel;
  /**
   * Корень workspace: абсолютные пути внутри показываются короткими
   * относительными в шапках тулов.
   */
  baseDir?: string;
  /** Сколько деталей рендерить (см. `docs/design/ui/STYLE.md`). */
  verbosity?: Verbosity;
}

/** Тулы без busy-спиннера: висят на промпте пользователя. */
const SPINNERLESS_TOOLS = new Set(["question", "approve"]);

/** Rich-терминал: TTY и не CI. */
export function isRichTerminal(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

/**
 * Стримит события агента в терминал. Rich-режим (TTY) добавляет спиннер;
 * plain — простые строки с префиксом.
 * Цвета из `colors.ts`, вне TTY / в CI / при NO_COLOR выключены.
 */
export class Renderer {
  private rich: boolean;
  private spinner: Spinner;
  private fmt: FormattingStream;
  private channel: OutputChannel;
  private termWidth: number;
  private baseDir?: string;
  private verbosity: Verbosity;
  private card: CardState | null = null;
  private readonly thought: ThoughtBlock;
  private readonly body = new BodyStream();
  private textStarted = false;
  private readonly quiet: QuietFlow;

  constructor(opts: RendererOptions = {}) {
    this.rich = opts.rich ?? isRichTerminal();
    this.termWidth = opts.width ?? getTerminalWidth();
    this.baseDir = opts.baseDir;
    this.verbosity = opts.verbosity ?? "normal";
    this.channel = opts.channel ?? getDefaultChannel();
    this.spinner = new Spinner({
      enabled: this.rich && (opts.spinner ?? true),
      channel: this.channel,
      width: this.termWidth,
    });
    this.fmt = new FormattingStream(
      (line) => this.channel.writeRaw(`${line}\n`),
      this.termWidth,
      (text) => this.channel.writeRaw(text),
      { reservedCols: 2, streamPartials: this.rich },
    );
    this.thought = new ThoughtBlock(this.channel);
    this.quiet = new QuietFlow(this.channel);
  }

  /** Актуальная ширина терминала (перемеряется при resize). */
  get width(): number {
    return this.termWidth;
  }

  /** Переизмерить ширину терминала (resize/SIGWINCH) — аудит §8.12. */
  onResize(width: number = getTerminalWidth()): void {
    this.termWidth = width;
    this.spinner.setWidth(width);
    this.fmt.setWidth(width);
  }

  /** Спиннер обдумывания на время ожидания ответа LLM. */
  showLoader(): void {
    this.spinner.start(t("ui.thinking"));
  }

  /** Финальный ответ модели стримом (markdown-формат). */
  text(chunk: string): void {
    this.endCard();
    this.quiet.flushRecon();
    this.thought.finish();
    this.spinner.stop();
    if (!this.textStarted) {
      this.textStarted = true;
      // Ответ уже введён разделителем/ярлыком REPL; ведущий маркер конфликтовал
      // бы с кодовым блоком, открывающим ответ.
      this.channel.writeRaw("\n");
    }
    this.fmt.write(chunk);
  }

  /** Произвольный статус/мета-текст (вывод тула, reasoning). */
  meta(chunk: string): void {
    this.spinner.stop();
    if (this.thought.isOpen) {
      this.thought.ensureHeader();
      this.channel.writeRaw(pc.dim(chunk));
    } else if (this.card) {
      this.body.write(chunk, this.card, this.verbosity === "quiet", this.channel);
    } else {
      this.quiet.flushRecon();
      this.channel.writeRaw(chunk);
    }
  }

  /** Dim-стрим рассуждений (красится здесь, а не агентом). */
  reasoning(chunk: string): void {
    this.spinner.stop();
    this.quiet.flushRecon();
    this.thought.ensureHeader();
    this.channel.writeRaw(pc.dim(chunk));
  }

  /** Модель грузится/генерирует; `info.level` — фактическая ступень (INV-R9). */
  thinkingStart(info?: { level?: string; source?: string }): void {
    this.quiet.flushRecon();
    this.thought.begin();
    this.spinner.start(info?.level ? `${t("ui.thinking")} · ${info.level}` : t("ui.thinking"));
  }

  /** Вызов LLM завершён; печатаем длительность и закрываем блок мысли. */
  thinkingEnd(): void {
    this.spinner.stop();
    this.thought.finish();
  }

  /** Старт тула: шапка действия + busy-спиннер (кроме интерактивных). */
  toolStart(
    tool: string,
    args: Record<string, unknown>,
    stepContext?: string | null,
    _icon?: string,
  ): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.thought.finish();
    this.body.reset();
    const displayArgs =
      isPathTool(tool) && typeof args.path === "string"
        ? { ...args, path: toDisplayPath(this.baseDir, args.path) }
        : args;
    const summary = humanArgs(tool, displayArgs);
    const label = friendlyTool(tool);
    // Один глиф в цвете категории — пер-тул emoji-иконки не используются.
    const mark = glyph.action;
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
      this.channel.writeRaw(`${actionHead(mark, tool, label, summary)}\n`);
    }
    // Busy-индикатор на время реального исполнения: read/write/edit/bash могут
    // идти секунды; без него чат выглядит зависшим до футера.
    if (!SPINNERLESS_TOOLS.has(tool)) {
      this.spinner.start(`${label}${summary ? ` ${summary}` : ""}`);
    }
  }

  /** Смена детализации рендера (использует `/verbose`). */
  setVerbosity(verbosity: Verbosity): void {
    this.verbosity = verbosity;
  }

  /** Живой чеклист плана: печатает блок как есть (уже раскрашен). */
  planBlock(lines: string[]): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.quiet.flushRecon();
    for (const line of lines) {
      this.channel.writeRaw(`${line}\n`);
    }
  }

  /** Конец тула: футер с длительностью (ошибка → красный маркер + первая строка тела). */
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
    const { label, summary, deferred } = this.card;
    const tail = footerTail(error ? failureMark() : successMark(), duration, ctxDelta, costUsd);
    if (deferred) {
      this.quiet.finish(this.card, duration, error, tail);
    } else {
      this.channel.writeRaw(`${GUTTER}${tail}\n`);
      const overflow = this.body.overflow;
      if (overflow > 0) {
        this.channel.writeRaw(`${GUTTER}${pc.dim(`... (${overflow} more lines)`)}\n`);
      }
    }
    this.recordLast(label, summary, error, duration);
    this.card = null;
  }

  /** Запоминает действие для допечатки по `Ctrl+O` (живёт дольше прогона). */
  private recordLast(
    label: string,
    summary: string,
    error: boolean | undefined,
    duration: number,
  ): void {
    recordCard(this.card, label, summary, error, duration);
  }

  /** Сырой предформатированный текст (диффы, предупреждения). */
  raw(text: string): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.quiet.flushRecon();
    this.channel.writeRaw(text);
  }

  /** Ошибка в stderr с красным маркером. */
  error(text: string): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.quiet.flushRecon();
    this.channel.writeRaw(`${failureMark()} ${pc.red(text)}\n`, "stderr");
  }

  /** Сброс всех буферов в конце хода. */
  flush(): void {
    this.endCard();
    this.quiet.flushRecon();
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.fmt.flush();
    this.textStarted = false;
  }

  /** Футер с моделью, провайдером и общей длительностью. */
  footer(model: string, provider: string, durationMs: number): void {
    this.quiet.flushRecon();
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
