/**
 * Диспетчер строк ввода REPL: очередь + мультистрочный буфер.
 *
 * Вынесено из `repl.ts` (правило 6): `readline` эмитит строки подряд, не
 * дожидаясь async-хендлера, поэтому без очереди пастнутые команды обгоняли
 * друг друга, а `/exit` успевал закрыть REPL посреди хода агента.
 */
import { LineDispatcher } from "./line-dispatch";
import { inputPrompt, type ReplPromptHost } from "./repl-prompt";
import { rememberInput } from "./repl-history";
import type { Logger } from "../logger/app-logger";

/** Узкий вид `Repl`, нужный диспетчеру. */
export interface ReplDispatcherHost extends ReplPromptHost {
  history: string[];
  historyPath: string;
  maxHistory: number;
  logger?: Logger;
  executeCommand(line: string): Promise<void>;
  afterCommand(): void;
  runAgent(input: string): Promise<void>;
}

/** Проверка незакрытого многострочного ввода (хвостовой `\` или `{` без `}`). */
export function isMultiLineInput(line: string): boolean {
  if (line.endsWith("\\")) return true;
  const openBraces = (line.match(/\{/g) || []).length;
  const closeBraces = (line.match(/\}/g) || []).length;
  return openBraces > closeBraces;
}

export function createLineDispatcher(host: ReplDispatcherHost): LineDispatcher {
  return new LineDispatcher(
    {
      isBusy: () => host.agentRunning || host.inputLocked,
      remember: (line) => rememberInput(host, line),
      executeCommand: (line) => host.executeCommand(line),
      afterCommand: () => host.afterCommand(),
      runAgent: (input) => host.runAgent(input),
      isMultiLineInput: (text) => isMultiLineInput(text),
      promptContinuation: () => {
        host.rl.setPrompt(inputPrompt(host, true));
        host.rl.prompt();
      },
      promptIdle: () => {
        host.rl.setPrompt(inputPrompt(host));
        host.rl.prompt();
      },
    },
    (err) =>
      host.logger?.warn(
        `repl input task failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
  );
}
