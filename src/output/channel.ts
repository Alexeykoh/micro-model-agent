// Канал вывода: единственный владелец терминала (режимы idle/stream/modal/quiet).
import { defaultOutputBus, type OutputBus } from "./bus";
import { formatEventLine } from "./format";
import type { OutputEvent, OutputStream } from "./types";

/** Сток промпта: куда печатать поверх поля ввода. */
export interface PromptSink {
  isActive(): boolean;
  printAbove(text: string): void;
  clearScreen?(): void;
}

/** Режим канала: idle — промпт владеет экраном, streaming — стрим, modal — очередь, quiet — тишина. */
export type ChannelMode = "idle" | "streaming" | "modal" | "quiet";

/** Опции канала: потоки вывода и цвет. */
export interface OutputChannelOptions {
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  color?: boolean;
}

/** Единственный писатель в терминал; подписывается на шину и рендерит события. */
export class OutputChannel {
  private out: NodeJS.WritableStream;
  private err: NodeJS.WritableStream;
  private color: boolean;
  private mode: ChannelMode = "idle";
  private modeBeforeQuiet: ChannelMode = "idle";
  private modeBeforeModal: ChannelMode = "idle";
  private modalDepth = 0;
  private sink: PromptSink | null = null;
  private queue: OutputEvent[] = [];
  private pending: { stream: OutputStream; text: string } | null = null;
  private partialOpen = false;
  /**
   * Log/block-события stdout, пойманные при активном промпте. Сбрасываются раз
   * в микротаску, чтобы синхронный всплеск (например, 20-строчный результат
   * команды) дал один `printAbove` + один ререндер кадра, а не по одному на
   * строку (каждый стирал/перерисовывал кадр и слал DSR-запрос).
   */
  private blockLines: string[] | null = null;
  private blockFlushScheduled = false;
  private readonly unsub: () => void;
  /**
   * Глушит `info`-логи на человеческом терминале. Структурные логи — это
   * диагностика, а не чат: quiet оставляет только warn/error. `writeLine`-блоки
   * (help, status, вывод команд) не затрагиваются.
   */
  private suppressInfoLogs = false;
  /**
   * Показ `data.diagnostic`-событий (внутренняя диагностика петли) в терминале.
   * По умолчанию выкл: диагностика живёт в `.log`/`app.jsonl` и выходит в чат
   * только при `ui.verbosity === "verbose"`.
   */
  private showDiagnostics = false;

  constructor(
    private bus: OutputBus = defaultOutputBus,
    opts: OutputChannelOptions = {},
  ) {
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
    const outTTY = (this.out as { isTTY?: boolean }).isTTY === true;
    this.color = opts.color ?? (!process.env.NO_COLOR && !process.env.CI && outTTY);
    this.unsub = this.bus.subscribe((ev) => this.onEvent(ev));
  }

  /** Отписка от шины и сброс состояния. */
  dispose(): void {
    this.flushBlocks();
    this.unsub();
    this.queue = [];
    this.pending = null;
    this.partialOpen = false;
    this.sink = null;
    this.mode = "idle";
  }

  /** Привязка/отвязка промпта (null — терминал свободен). */
  attachPrompt(sink: PromptSink | null): void {
    this.sink = sink;
  }

  /** Текущий режим канала. */
  getMode(): ChannelMode {
    return this.mode;
  }

  /** Начало стрима ответа. Quiet не сбрасывается: `--json` молчит весь прогон. */
  beginStreaming(): void {
    // Переход в стрим не должен сбрасывать quiet: `--json` ставит quiet на весь
    // прогон, и стримящиеся прогоны обязаны молчать.
    if (this.mode === "quiet") return;
    this.flushBlocks();
    this.flushPendingAsBlock();
    this.mode = "streaming";
  }

  /** Конец стрима. Симметрично beginStreaming: quiet владеет режимом до setQuiet(false). */
  endStreaming(): void {
    // Симметрично beginStreaming: quiet владеет режимом до setQuiet(false).
    if (this.mode === "quiet") return;
    this.closePartial();
    this.mode = "idle";
  }

  /** Вход в модалку: события копятся в очередь до endModal. */
  beginModal(): void {
    this.flushBlocks();
    this.flushPendingAsBlock();
    if (this.mode === "quiet") return; // quiet владеет setQuiet
    // Вложенные модалки (визард внутри другой эксклюзивной области) не должны
    // затирать режим, сохранённый самой внешней beginModal.
    if (this.modalDepth === 0) this.modeBeforeModal = this.mode;
    this.modalDepth++;
    this.mode = "modal";
  }

  /** Выход из модалки: сброс очереди накопленных событий в onEvent. */
  endModal(): void {
    if (this.modalDepth > 0) this.modalDepth--;
    if (this.mode === "modal" && this.modalDepth === 0) this.mode = this.modeBeforeModal;
    const q = this.queue;
    this.queue = [];
    for (const ev of q) this.onEvent(ev);
  }

  /** Вкл/выкл quiet (`--json`): человеческий вывод дропается. */
  setQuiet(quiet: boolean): void {
    this.flushBlocks();
    if (quiet) {
      if (this.mode !== "quiet") {
        this.modeBeforeQuiet = this.mode;
        this.mode = "quiet";
      }
    } else if (this.mode === "quiet") {
      this.mode = this.modeBeforeQuiet;
    }
  }

  /** Скрыть `info`-логи терминала (warn/error остаются). */
  setSuppressInfoLogs(suppress: boolean): void {
    this.suppressInfoLogs = suppress;
  }

  /** Показать внутреннюю диагностику (`Logger.diagnostic`) — только verbose. */
  setShowDiagnostics(show: boolean): void {
    this.showDiagnostics = show;
  }

  /** Сырая запись в поток. В modal/quiet дропается, в idle идёт поверх промпта. */
  writeRaw(text: string, stream: OutputStream = "stdout"): void {
    // Сырой вывод не должен обгонять очередь блочных строк.
    this.flushBlocks();
    // modal осознанно дропает прямые записи: рендерер в модальном промпте не работает.
    if (this.mode === "modal" || this.mode === "quiet") return;
    if (this.mode === "idle" && this.sink?.isActive() && stream === "stdout") {
      const prev = this.pending?.stream === "stdout" ? this.pending.text : "";
      this.pending = { stream, text: prev + text };
      this.drainPending();
      return;
    }
    if (stream === "stdout") this.partialOpen = !text.endsWith("\n");
    (stream === "stderr" ? this.err : this.out).write(text);
  }

  /** Блочная запись через шину (help, status, вывод команд). */
  writeLine(text: string, stream: OutputStream = "stdout"): void {
    this.bus.emit({ level: "info", source: "mma", kind: "block", text, stream });
  }

  /** Очистка экрана через промпт или ANSI. Буферный raw-партиал сбрасывается первым. */
  clearScreen(): void {
    this.flushBlocks();
    // Иначе буферная raw-частичная строка всплывёт после очистки.
    this.flushPendingAsBlock();
    this.partialOpen = false;
    if (this.mode === "quiet") return;
    if (this.sink?.isActive() && this.sink.clearScreen) {
      this.sink.clearScreen();
      return;
    }
    this.out.write("\x1b[2J\x1b[H");
  }

  /** Оверлей (спиннер) в stderr. В modal/quiet и при активном промпте дропается. */
  writeOverlay(text: string): void {
    // modal осознанно дропает оверлеи: рендерер в модальном промпте не работает.
    // Спиннер обязан остановиться до любого лога, иначе оверлей делит строку с логом.
    if (this.mode === "modal" || this.mode === "quiet") return;
    if (this.mode === "idle" && this.sink?.isActive()) return;
    this.err.write(text);
  }

  /** Режимы и фильтры, держащие событие вне терминала. */
  private shouldDrop(ev: OutputEvent): boolean {
    if (this.mode === "quiet") return true;
    // Структурные info-логи — диагностика, а не чат: quiet их прячет.
    if (this.suppressInfoLogs && ev.kind === "log" && ev.level === "info") return true;
    // Внутренняя диагностика петли — материал логов сессии, а не чата: в терминал
    // только через verbose (setShowDiagnostics).
    if (!this.showDiagnostics && ev.kind === "log" && ev.data?.diagnostic === true) return true;
    return false;
  }

  /** Пакует синхронный всплеск в один printAbove/рендер (см. blockLines). */
  private queueBlockLine(line: string): void {
    // Оба потока идут поверх промпта, иначе stderr-лог ляжет прямо на кадр
    // ввода в обход порядка flushBlocks.
    if (this.blockLines === null) this.blockLines = [];
    this.blockLines.push(line);
    if (this.blockFlushScheduled) return;
    this.blockFlushScheduled = true;
    queueMicrotask(() => this.flushBlocks());
  }

  private onEvent(ev: OutputEvent): void {
    if (this.shouldDrop(ev)) return;
    if (this.mode === "modal") {
      this.queue.push(ev);
      return;
    }
    if (ev.kind === "raw") {
      this.writeRaw(ev.text, ev.stream);
      return;
    }
    const stream = ev.stream ?? "stdout";
    const line = ev.kind === "block" ? ev.text : formatEventLine(ev, this.color);
    if (this.mode === "idle" && this.sink?.isActive()) {
      this.queueBlockLine(line);
      return;
    }
    // Сохраняем FIFO: буферные блоки не должен обгонять эвент, писанный
    // напрямую в raw-поток (например, stderr-лог посреди стрима).
    this.flushBlocks();
    if (this.mode === "streaming") this.closePartial();
    (stream === "stderr" ? this.err : this.out).write(`${line}\n`);
  }

  private flushBlocks(): void {
    this.blockFlushScheduled = false;
    const lines = this.blockLines;
    this.blockLines = null;
    if (!lines || lines.length === 0) return;
    const text = lines.join("\n");
    if (this.sink?.isActive()) {
      this.sink.printAbove(text);
    } else {
      this.out.write(`${text}\n`);
    }
  }

  private closePartial(): void {
    if (this.partialOpen) {
      this.out.write("\n");
      this.partialOpen = false;
    }
  }

  private drainPending(): void {
    if (!this.pending) return;
    const { stream, text } = this.pending;
    const idx = text.lastIndexOf("\n");
    if (idx < 0) return;
    const head = text.slice(0, idx + 1);
    this.pending = { stream, text: text.slice(idx + 1) };
    const lines = head.replace(/\n$/, "").split("\n");
    if (this.sink?.isActive()) this.sink.printAbove(lines.join("\n"));
    else this.out.write(head);
  }

  private flushPendingAsBlock(): void {
    this.flushBlocks();
    if (!this.pending) return;
    const text = this.pending.text;
    const { stream } = this.pending;
    this.pending = null;
    if (this.sink?.isActive()) {
      this.sink.printAbove(text);
      this.partialOpen = false;
    } else {
      (stream === "stderr" ? this.err : this.out).write(text);
      this.partialOpen = stream === "stdout" ? !text.endsWith("\n") : this.partialOpen;
    }
  }
}
