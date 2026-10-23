// Рендерер чата: события агента в терминальные строки по STYLE.md.
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
import { recordToolAction } from "./action-log";
import { sanitizeOutput } from "./sanitize-output";

import { getTerminalWidth } from "./table";
import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";
import { getDefaultChannel, type OutputChannel } from "../output";
import { isAbsolute, relative, sep } from "path";

function formatUsd(cost: number): string {
  return formatCost(cost);
}

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

/** Тулы, чей аргумент `path` показывается в шапке. */
const PATH_TOOLS = new Set([
  "read_file", "write_file", "append_file",
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
  // Вне baseDir (префикс ../) или другой диск (абсолютный результат) — как есть.
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel.split(sep).join("/");
}

const GUTTER = "  ";
const MAX_OUTPUT_LINES = 50;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Тулы без busy-спиннера: висят на промпте пользователя. */
const SPINNERLESS_TOOLS = new Set(["question", "approve"]);

/**
 * Read-only тулы разведки. В quiet прогон сворачивается в `│ N actions ✓`.
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
 * Ведущий маркер каждого действия. В стиле один маркер (`◇`) на все тулы:
 * категории передаются локализованным ярлыком, а не глифом.
 */
export function toolMarker(_tool: string): string {
  return glyph.action;
}

/** Rich-терминал: TTY и не CI. */
export function isRichTerminal(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.CI;
}

/** Короткая человекочитаемая сводка аргументов тула. */
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

/** Скалярные ключи, показываемые как есть, в порядке приоритета, для обычных тулов. */
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
 * Человекочитаемая сводка аргументов. Структурные тулы несут сырой JSON,
 * который потёк бы в чат, — им короткая локализованная фраза.
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
  if (tool === "plan_step") {
    const step = args.step;
    const status = args.status;
    if (step !== undefined || status !== undefined) {
      return t("ui.plan_update", {
        step: String(step ?? "?"),
        status: String(status ?? "?"),
      });
    }
  }
  if (tool === "todo") {
    const action = typeof args.action === "string" ? args.action : "";
    const items = Array.isArray(args.items) ? args.items.length : undefined;
    if (action && items !== undefined) return t("ui.todo_action", { action, count: String(items) });
    if (action) return action;
  }
  // Обычные экшен-тулы (browser, project_map, lsp_check, …) несут `action` плюс
  // пару коротких скаляров — рендерим фразу, а не сырой JSON.
  if (typeof args.action === "string" && args.action) {
    const extras = ["direction", "selector", "key", "name", "path", "url", "query", "text", "id"]
      .map((k) => (typeof args[k] === "string" && args[k] ? (args[k] as string) : undefined))
      .filter((v): v is string => Boolean(v));
    return truncateArg([args.action, ...extras].join(" "));
  }
  // Композиты, где один ключ уронил бы половину смысла.
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
 * Локализованный человеческий ярлык тула. Системные имена (`read_file`, `bash`, …)
 * НЕ показываются юзеру — см. `docs/design/ui/STYLE.md`.
 */
function friendlyTool(tool: string): string {
  const key = `tool.friendly.${tool}`;
  const value = t(key);
  if (value !== key) return value;
  const fallback = t("ui.action_fallback");
  return fallback !== "ui.action_fallback" ? fallback : "Action";
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
  /** Чередует короткие человеческие ярлыки, чтобы повторы thinking не звучали роботно. */
  private thinkingCount = 0;
  private thinkingLabel = "";
  private textStarted = false;
  private reconBuffer: ReconItem[] = [];
  /** Отложенная на шаг строка действия (quiet): повтор сворачивается в `×N`. */
  private pendingFooter: {
    key: string;
    leadMark: string;
    tool: string;
    label: string;
    summary: string;
    duration: number;
  } | null = null;
  private repeatCount = 0;
  private repeatMs = 0;
  private outputLineCount = 0;
  private outputSuppressed = false;

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
    this.flushRecon();
    this.closeThought();
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

  /** Стримит строки тела тула с гуттером, пустые скипает. */
  private writeInlineBody(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      const plain = sanitizeOutput(stripAnsi(line)).trim();
      if (this.card) {
        if (this.card.body.length < MAX_OUTPUT_LINES) this.card.body.push(plain);
        if (!this.card.firstBody) this.card.firstBody = plain;
      }
      if (this.verbosity === "quiet") {
        // Первую строку держим, чтобы у провала осталось короткое объяснение, но
        // чат не заливаем: детали — через /verbose и Ctrl+O.
        continue;
      }
      this.outputLineCount++;
      if (this.outputLineCount > MAX_OUTPUT_LINES) {
        this.outputSuppressed = true;
        continue;
      }
      this.channel.writeRaw(`${GUTTER}${sanitizeOutput(line)}\n`);
    }
  }

  /** Dim-стрим рассуждений (красится здесь, а не агентом). */
  reasoning(chunk: string): void {
    this.spinner.stop();
    this.flushRecon();
    this.writeThoughtHeader();
    this.channel.writeRaw(pc.dim(chunk));
  }

  /**
   * Открывает блок мысли: `✦ <акцентный ярлык> · ` — ярлык держит акцент
   * рассуждений, разделитель и тело dim.
   */
  private writeThoughtHeader(): void {
    if (!this.thoughtStarted || this.thoughtHeaderPrinted) return;
    this.channel.writeRaw(
      `\n${pc.magenta(glyph.thinking)} ${pc.magenta(this.thinkingLabel)} ${pc.dim("·")} `,
    );
    this.thoughtHeaderPrinted = true;
  }

  /** Модель грузится/генерирует; `info.level` — фактическая ступень (INV-R9). */
  thinkingStart(info?: { level?: string; source?: string }): void {
    this.flushRecon();
    this.thoughtStarted = true;
    this.thoughtStartMs = Date.now();
    this.thoughtHeaderPrinted = false;
    this.thinkingLabel = this.nextThinkingLabel();
    this.spinner.start(info?.level ? `${t("ui.thinking")} · ${info.level}` : t("ui.thinking"));
  }

  /**
   * Чередует несколько коротких человеческих ярлыков по фазам thinking. Первая
   * фаза всегда канонична `ui.thinking_label` (стабильно в тестах/скринах).
   */
  private nextThinkingLabel(): string {
    const index = this.thinkingCount++;
    const key = index === 0 ? "ui.thinking_label" : `ui.thinking_label_${(index % 3) + 1}`;
    const value = t(key);
    return value !== key ? value : t("ui.thinking_label");
  }

  /** Вызов LLM завершён; печатаем длительность и закрываем блок мысли. */
  thinkingEnd(): void {
    this.spinner.stop();
    this.closeThought();
  }

  /**
   * Закрывает открытый блок мысли с печатью длительности. Безопасно звать
   * многократно: и финальный ответ, и следующий тул требуют закрытого блока,
   * чтобы длительность не приземлилась внутрь текста ответа.
   */
  private closeThought(): void {
    if (this.thoughtStarted && this.thoughtHeaderPrinted) {
      const duration = Date.now() - this.thoughtStartMs;
      this.channel.writeRaw(pc.dim(` ${formatDuration(duration)}\n`));
    }
    this.thoughtStarted = false;
    this.thoughtHeaderPrinted = false;
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
    this.closeThought();
    this.outputLineCount = 0;
    this.outputSuppressed = false;
    const displayArgs =
      PATH_TOOLS.has(tool) && typeof args.path === "string"
        ? { ...args, path: toDisplayPath(this.baseDir, args.path) }
        : args;
    const summary = humanArgs(tool, displayArgs);
    const label = friendlyTool(tool);
    // Один глиф в цвете категории — пер-тул emoji-иконки не используются.
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

  /** Выпуск буферного прогона read-only действий (quiet). */
  private flushRecon(): void {
    // Отложенная строка действия всегда старше любого буферного recon-прогона:
    // печатаем её первой, чтобы чат остался хронологичным.
    this.flushPendingFooter();
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

  /** Печать отложенной строки, повторы сворачивает в одну строку `×N`. */
  private flushPendingFooter(): void {
    const p = this.pendingFooter;
    if (!p) return;
    this.pendingFooter = null;
    const times = this.repeatCount + 1;
    const total = p.duration + this.repeatMs;
    this.repeatCount = 0;
    this.repeatMs = 0;
    const head = `${p.leadMark} ${toolAccent(p.tool)(p.label)}${
      p.summary ? ` ${pc.dim("·")} ${pc.dim(p.summary)}` : ""
    }`;
    const timesPart = times > 1 ? ` ${pc.dim(`×${times}`)}` : "";
    this.channel.writeRaw(
      `${head}  ${successMark()} ${pc.dim(formatDuration(total))}${timesPart}\n`,
    );
  }

  /** Живой чеклист плана: печатает блок как есть (уже раскрашен). */
  planBlock(lines: string[]): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.flushRecon();
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
      this.toolEndDeferred(tail, duration, error);
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

  /**
   * Quiet-футер: сворачивает отложенную шапку в одну строку действия.
   * Успешные read-only тулы буферятся в recon-сводку; подряд идущие одинаковые
   * успешные сворачиваются в строку `×N`; всё прочее буферится на шаг, чтобы
   * повтор успел свернуться. Ошибки печатаются сразу.
   */
  private toolEndDeferred(tail: string, duration: number, error: boolean | undefined): void {
    const card = this.card;
    if (!card) return;
    const { label, summary, mark: leadMark, firstBody } = card;
    // Прогон успешных read-only тулов буферится и суммируется.
    if (!error && RECON_TOOLS.has(card.tool)) {
      this.flushPendingFooter();
      this.reconBuffer.push({ tool: card.tool, mark: leadMark, label, summary, duration });
      return;
    }
    // Подряд идущие одинаковые успешные действия (poll-циклы, повторные
    // статус-чеки) — в одну строку `×N` вместо N строк.
    const repeatKey = `${card.tool}::${label}::${summary}`;
    if (!error && this.pendingFooter?.key === repeatKey) {
      this.repeatCount += 1;
      this.repeatMs += duration;
      return;
    }
    this.flushPendingFooter();
    this.flushRecon();
    if (!error) {
      // Буфер на шаг: строка печатается на следующем действии (или любом сбросе),
      // чтобы идентичный повтор успел свернуться.
      this.pendingFooter = {
        key: repeatKey,
        leadMark,
        tool: card.tool,
        label,
        summary,
        duration,
      };
      return;
    }
    const head = `${leadMark} ${toolAccent(card.tool)(label)}${
      summary ? ` ${pc.dim("·")} ${pc.dim(summary)}` : ""
    }`;
    this.channel.writeRaw(`${head}  ${tail}\n`);
    if (error && firstBody) {
      const soft = firstBody.startsWith("⚠");
      const color = soft ? pc.yellow : pc.red;
      this.channel.writeRaw(`${GUTTER}${pc.dim(glyph.detail)} ${color(firstBody)}\n`);
    }
  }

  /** Запоминает действие для допечатки по `Ctrl+O` (живёт дольше прогона). */
  private recordLast(
    label: string,
    summary: string,
    error: boolean | undefined,
    duration: number,
  ): void {
    const card = this.card;
    recordToolAction({
      tool: card?.tool ?? "",
      label,
      summary,
      error,
      durationMs: duration,
      firstBody: card?.firstBody ?? "",
      body: card?.body ?? [],
    });
  }

  /** Сырой предформатированный текст (диффы, предупреждения). */
  raw(text: string): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.flushRecon();
    this.channel.writeRaw(text);
  }

  /** Ошибка в stderr с красным маркером. */
  error(text: string): void {
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.endCard();
    this.flushRecon();
    this.channel.writeRaw(`${failureMark()} ${pc.red(text)}\n`, "stderr");
  }

  /** Сброс всех буферов в конце хода. */
  flush(): void {
    this.endCard();
    this.flushRecon();
    this.spinner.stop();
    this.fmt.flushPartialNow();
    this.fmt.flush();
    this.textStarted = false;
  }

  /** Футер с моделью, провайдером и общей длительностью. */
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
