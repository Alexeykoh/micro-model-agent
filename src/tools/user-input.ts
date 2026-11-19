/** Низкоуровневый ввод юзера: меню/парсинг выбора по STYLE.md, readline-фолбэк. */
import * as readline from "readline";
import { t } from "../i18n/index";
import { getDefaultChannel } from "../output/index";
import type { PromptIO } from "./prompt-io";

/** Вариант выбора: подпись + пояснение. */
export interface InputOption {
  label: string;
  description: string;
}

/** Опции выбора: мультивыбор, кастомный ответ. */
export interface AskChoiceOptions {
  multiple?: boolean;
  allowCustom?: boolean;
}

/** Опции вопроса: заголовок, опции, прогресс, кастом. */
export interface AskUserOptions extends AskChoiceOptions {
  header?: string;
  options?: InputOption[];
  progress?: string;
  /** Разрешить свой ответ текстом (дефолт: true при наличии опций). */
  custom?: boolean;
}

/** Индекс выбора "свой ответ" из askChoice. */
export const CUSTOM_INDEX = -1;

/**
 * Парсит ввод вида "1" или "1,3" в 0-based индексы. Невалидное (пусто,
 * нецифры, вне диапазона, дубли, несколько при multiple=false) — null.
 */
export function parseSelection(
  input: string,
  optionCount: number,
  multiple: boolean,
): number[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(",").map((p) => p.trim());
  if (!multiple && parts.length > 1) return null;
  const indexes: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const idx = Number(part) - 1;
    if (idx < 0 || idx >= optionCount) return null;
    if (indexes.includes(idx)) return null;
    indexes.push(idx);
  }
  return indexes.length ? indexes : null;
}

/** Рендерит `? <вопрос>` + опции с отступом по STYLE.md. */
export function formatMenu(
  question: string,
  options: InputOption[],
  opts: AskChoiceOptions = {},
): string {
  const parts = question.split("\n");
  parts[parts.length - 1] = `? ${parts[parts.length - 1]}`;
  const lines: string[] = [...parts];
  options.forEach((opt, i) => {
    lines.push(`  [${i + 1}] ${opt.label} — ${opt.description}`);
  });
  if (opts.allowCustom) {
    lines.push(`  [${options.length + 1}] ${t("tool.user_input.custom_option")}`);
  }
  return lines.join("\n");
}

/** Маркер промпта выбора `>`, по STYLE.md. */
export function choicePrompt(optionCount: number, multiple: boolean): string {
  return multiple
    ? t("tool.user_input.choice_multiple")
    : t("tool.user_input.choice_single", { max: optionCount });
}

/** Создаёт readline-интерфейс на stdio. */
function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/** Одна строка промпта через readline. */
function promptLine(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => resolve(answer));
  });
}

/** Free-text вопрос. Возвращает триммированный ответ (может быть пуст). */
export async function askText(question: string): Promise<string> {
  const rl = createRl();
  try {
    const answer = await promptLine(rl, `${question} `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/**
 * Вопрос с выбором: нумерованное меню, ожидание валидного ввода.
 * Возвращает 0-based индексы; CUSTOM_INDEX — кастомный пункт.
 * Переспрашивает до валидного.
 */
export async function askChoice(
  question: string,
  options: InputOption[],
  opts: AskChoiceOptions = {},
): Promise<number[]> {
  const multiple = opts.multiple ?? false;
  const entryCount = options.length + (opts.allowCustom ? 1 : 0);
  const customEntry = options.length; // index of the custom entry, if enabled
  const rl = createRl();
  try {
    const channel = getDefaultChannel();
    channel.writeLine(formatMenu(question, options, opts));
    for (;;) {
      const answer = await promptLine(rl, choicePrompt(entryCount, multiple));
      const parsed = parseSelection(answer, entryCount, multiple);
      if (parsed) {
        return parsed.map((i) => (opts.allowCustom && i === customEntry ? CUSTOM_INDEX : i));
      }
      channel.writeLine(t("tool.user_input.invalid"));
    }
  } finally {
    rl.close();
  }
}

/**
 * Высокоуровневый хелпер тула question.
 * - Без опций: free-text, `[text]` или `[]` при пустом.
 * - С опциями: выбранные labels; кастомный пункт — введённый текст.
 *
 * При `io` (REPL) весь промптинг идёт через него (терминал взаймы у редактора
 * ввода). Без него (headless/non-REPL) — module-level readline-фолбэк выше.
 */
export async function askUser(
  question: string,
  opts: AskUserOptions = {},
  io?: PromptIO,
): Promise<string[]> {
  const header = [opts.progress, opts.header].filter(Boolean).join(" — ");
  if (!opts.options || opts.options.length === 0) {
    const text = header ? `${header}\n? ${question}` : `? ${question}`;
    const answer = io ? await io.askText(text) : await askText(text);
    return answer ? [answer] : [];
  }
  const text = header ? `${header}\n${question}` : question;
  const allowCustom = opts.custom ?? true;
  const indexes = io
    ? await io.askChoice(text, opts.options, { multiple: opts.multiple, allowCustom })
    : await askChoice(text, opts.options, { multiple: opts.multiple, allowCustom });
  const labels: string[] = [];
  for (const idx of indexes) {
    if (idx === CUSTOM_INDEX) {
      const custom = io
        ? await io.askText(t("tool.user_input.custom_prompt"))
        : await askText(t("tool.user_input.custom_prompt"));
      if (custom) labels.push(custom);
    } else {
      labels.push(opts.options[idx].label);
    }
  }
  return labels;
}
