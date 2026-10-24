/**
 * Диспетчер строк ввода REPL. `readline` эмитит `line` подряд, не дожидаясь
 * async-хендлера, поэтому без очереди пастнутые команды обгоняли друг друга,
 * а `/exit` успевал закрыть REPL посреди хода агента.
 *
 * Вынесено из `repl.ts` (правило 6): файл grandfathered, расширять его нельзя.
 */
import { InputQueue } from "./input-queue";

/** Узкий вид REPL, нужный диспетчеру; всё остальное остаётся в `Repl`. */
export interface LineDispatchHost {
  /** Занят ли агент/ввод прямо сейчас (гейт на момент ввода, не исполнения). */
  isBusy(): boolean;
  /** Строка попала в историю (даже если она будет проигнорирована). */
  remember(line: string): void;
  executeCommand(line: string): Promise<void>;
  afterCommand(): void;
  runAgent(input: string): Promise<void>;
  /** Нужно ли продолжение (незакрытый блок кода/кавычки). */
  isMultiLineInput(text: string): boolean;
  promptContinuation(): void;
  promptIdle(): void;
}

export class LineDispatcher {
  private buffer = "";
  private inMultiLine = false;
  private readonly queue: InputQueue;

  constructor(
    private readonly host: LineDispatchHost,
    onError?: (err: unknown) => void,
  ) {
    this.queue = new InputQueue(onError);
  }

  /** Точка входа из readline: строки идут строго в порядке ввода. */
  onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed) this.host.remember(trimmed);

    // Занятость оценивается на момент ввода: набранное во время хода по-прежнему
    // не запускается (только история), а пастнутые подряд строки идут очередью.
    if (this.host.isBusy()) return;
    this.queue.push(() => this.handle(line));
  }

  /** Дождаться опустошения очереди (шатдаун, тесты). */
  idle(): Promise<void> {
    return this.queue.idle();
  }

  private async handle(line: string): Promise<void> {
    const trimmed = line.trim();

    if (this.inMultiLine) {
      this.buffer += `\n${line}`;
      if (!this.host.isMultiLineInput(this.buffer)) {
        this.inMultiLine = false;
        const fullInput = this.buffer.trim();
        this.buffer = "";
        if (fullInput) {
          if (fullInput.startsWith("/")) {
            await this.host.executeCommand(fullInput);
            this.host.afterCommand();
          } else {
            await this.host.runAgent(fullInput);
          }
        }
      } else {
        this.host.promptContinuation();
      }
      return;
    }

    if (this.host.isMultiLineInput(trimmed)) {
      this.inMultiLine = true;
      this.buffer = trimmed;
      this.host.promptContinuation();
      return;
    }

    if (!trimmed) {
      this.host.promptIdle();
      return;
    }

    if (trimmed.startsWith("/")) {
      await this.host.executeCommand(trimmed);
      this.host.afterCommand();
    } else {
      await this.host.runAgent(trimmed);
    }
  }
}
