/**
 * Промпт ввода REPL: ярлык reasoning, кадр промпта, показ после команды и
 * одалживание терминала под вопрос интерактивного тула.
 *
 * Вынесено из `repl.ts` (правило 6). Хост — узкий вид `Repl`: кадр, конфиг,
 * агент и владение вводом.
 */
import { pc } from "../ui/colors";
import { LineEditor, type LineInput } from "../ui/line-editor";
import { t } from "../i18n/index";
import { writeNonTtyLine, type PromptSink } from "../output";
import { createCommandInput, type CommandInput } from "./command-context";
import { createPromptIO, type PromptIO } from "../tools/prompt-io";
import type { Agent } from "../core/agent";
import type { AppConfig } from "../config/types";
import type { OutputChannel } from "../output";

/** Поля `Repl`, нужные промпту. */
export interface ReplPromptHost {
  running: boolean;
  promptPresented: boolean;
  runHandledPrompt: boolean;
  inputLocked: boolean;
  agentRunning: boolean;
  rl: LineInput;
  config: AppConfig;
  agent: Agent;
  output: OutputChannel;
}

/**
 * Ярлык reasoning в промпте ввода. В `auto` эффективный уровень обычно решает
 * политика поитерационно, так что показываем лишь факт автоматики. При явном
 * оверрайде юзера (`/reasoning <level>`, персистентный) или активном
 * `set_thinking`-оверрайде агента (транзиентный) — `auto→<level>`. В фикс.
 * режиме — эффективный уровень.
 */
export function reasoningLabel(host: ReplPromptHost): string {
  const mode = host.config.reasoning?.mode ?? "default";
  if (mode !== "auto") return host.agent.reasoningLevel ?? mode;
  const rs = host.agent.reasoningState;
  const cooldown = host.config.reasoning?.overrideCooldown ?? 0;
  const transientActive =
    rs.overrideIteration >= 0 && host.agent.currentIteration - rs.overrideIteration <= cooldown;
  if (rs.manual || transientActive) return `auto→${host.agent.reasoningLevel}`;
  return "auto";
}

/** Локализованный промпт ввода со встроенным режимом/уровнем reasoning. */
export function inputPrompt(host: ReplPromptHost, continuation = false): string {
  const key = continuation ? "repl.you_reasoning_cont" : "repl.you_reasoning";
  return pc.cyan(t(key, { level: reasoningLabel(host) }));
}

/**
 * Перепоказ промпта ввода после slash-команды. У команд нет владения жизненным
 * циклом кадра, им нужна явная перерисовка. Путь агента осознанно исключён:
 * finally `runAgent` зовёт `LineEditor.resumeFrame()` как единственный показ —
 * промпт здесь дал бы двойную отрисовку.
 */
export function presentPrompt(host: ReplPromptHost): void {
  if (!host.running) return;
  host.rl.setPrompt(inputPrompt(host));
  host.rl.prompt();
  host.promptPresented = true;
}

/** Возврат обычного промпта после стартового вопроса, если активен LineEditor. */
export function restoreStartupPrompt(host: ReplPromptHost): void {
  if (host.rl instanceof LineEditor) {
    host.rl.setPrompt(inputPrompt(host));
    host.rl.prompt();
    host.promptPresented = true;
  }
}

/**
 * Одалживает терминал под один вопрос интерактивного тула и возвращает обратно.
 * На время прогона LineEditor suspended с выключенным вводом; включение ввода +
 * resume кадра даёт `question()` читать клавиши, пока агент блокирован, а `finally`
 * восстанавливает ровно стрим-состояние, и рендерер агента работает дальше как ни в чём.
 *
 * Порядок важен: `beginModal()` сначала сбрасывает вывод, ещё буферный у стрим-канала,
 * чтобы напечатался plain до возврата кадра; `endModal()` идёт лишь после повторного
 * suspend кадра, чтобы события, накопленные за вопрос, сбросились plain, а не побили кадр.
 */
export async function askViaEditor(host: ReplPromptHost, prompt: string): Promise<string> {
  const editor = host.rl instanceof LineEditor ? host.rl : null;
  const wasSuspended = editor ? editor.isFrameSuspended() : true;
  const wasEnabled = editor ? editor.isInputEnabled() : false;
  host.output.beginModal();
  if (editor) {
    editor.setInputEnabled(true);
    editor.resumeFrame();
  }
  try {
    return await new Promise<string>((resolve) => host.rl.question(prompt, resolve));
  } finally {
    if (editor) {
      editor.setInputEnabled(wasEnabled);
      if (wasSuspended) editor.suspendFrame();
      else editor.resumeFrame();
    }
    host.output.endModal();
  }
}

/** Мост, дающий каналу рисовать поверх живого кадра ввода. */
export function createPromptSink(host: ReplPromptHost): PromptSink {
  return {
    isActive: () =>
      host.rl instanceof LineEditor &&
      host.promptPresented &&
      !host.agentRunning &&
      !host.inputLocked,
    printAbove: (text: string) => {
      if (host.rl instanceof LineEditor) {
        host.rl.printAbove?.(text);
        return;
      }
      // Не-TTY фолбэк (readline / пайпнутый stdin): кадра ввода для перерисовки
      // сверху нет — пишем напрямую через санкционированный машинный хелпер:
      // `printAbove` здесь не про что.
      writeNonTtyLine(text);
    },
    clearScreen: () => {
      if (host.rl instanceof LineEditor) host.rl.clearScreen();
    },
  };
}

/** Одалживание терминала под вопрос и эксклюзивный ввод (адаптеры `CommandInput`). */
export interface ReplTerminalHost extends ReplPromptHost {
  withExclusiveInput<T>(fn: () => Promise<T>): Promise<T>;
}

/** Кого отдаём классу: ввод команд и промпт-поверхность для тулов. */
export interface ReplTerminalSurfaces {
  input: CommandInput;
  promptIO: PromptIO;
}

/**
 * Собирает терминальные поверхности REPL: адаптер ввода команд, синк канала
 * поверх кадра и PromptIO для интерактивных тулов. Одалживание терминала —
 * через `withExclusiveInput` самого хоста.
 */
export function attachTerminal(host: ReplTerminalHost): ReplTerminalSurfaces {
  const input = createCommandInput(
    host.rl,
    (prompt) => askViaEditor(host, prompt),
    (fn) => host.withExclusiveInput(fn),
  );
  host.output.attachPrompt(createPromptSink(host));
  const promptIO = createPromptIO({
    ask: (prompt) => askViaEditor(host, prompt),
    print: (line) => host.output.writeModal(line),
  });
  host.agent.setPromptIO?.(promptIO);
  return { input, promptIO };
}

/**
 * Эксклюзивный ввод: визард владеет терминалом через свои `rl.question()`.
 * Обобщён, чтобы служить адаптером `CommandInput.withInput` для команд.
 */
export async function withExclusiveInput<T>(
  host: ReplPromptHost,
  fn: () => Promise<T>,
): Promise<T> {
  // Между вопросами активного кадра нет, так что меню/результаты скана пишутся
  // напрямую: обёртка beginModal/endModal сложила бы ВЕСЬ транскрипт в очередь,
  // и юзер видел бы голые `: ` промпты до конца. `inputLocked` гасит
  // `promptSink.isActive()`, пуская записи напрямую.
  host.inputLocked = true;
  try {
    return await fn();
  } finally {
    host.inputLocked = false;
  }
}
