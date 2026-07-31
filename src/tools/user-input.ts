import * as readline from "readline";
import { t } from "../i18n/index";

export interface InputOption {
  label: string;
  description: string;
}

export interface AskChoiceOptions {
  multiple?: boolean;
  allowCustom?: boolean;
}

export interface AskUserOptions extends AskChoiceOptions {
  header?: string;
  options?: InputOption[];
  progress?: string;
  /** Allow typing a custom answer (default: true when options are present). */
  custom?: boolean;
}

/** Index returned by askChoice when the user picks the "custom answer" entry. */
export const CUSTOM_INDEX = -1;

/**
 * Parse user input like "1" or "1,3" into 0-based option indexes.
 * Returns null on invalid input (empty, non-numeric, out of range,
 * duplicates, or multiple values when multiple is false).
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

/** Render question + numbered option list as a single string. */
export function formatMenu(
  question: string,
  options: InputOption[],
  opts: AskChoiceOptions = {},
): string {
  const lines: string[] = [question];
  options.forEach((opt, i) => {
    lines.push(`  [${i + 1}] ${opt.label} — ${opt.description}`);
  });
  if (opts.allowCustom) {
    lines.push(
      `  [${options.length + 1}] ${t("tool.user_input.custom_option")}`,
    );
  }
  return lines.join("\n");
}

/** Prompt text for the choice input. */
export function choicePrompt(optionCount: number, multiple: boolean): string {
  return multiple
    ? t("tool.user_input.choice_multiple")
    : t("tool.user_input.choice_single", { max: optionCount });
}

function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function promptLine(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => resolve(answer));
  });
}

/** Free-text question. Returns trimmed answer (may be empty). */
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
 * Choice question: shows a numbered menu and waits for a valid selection.
 * Returns selected 0-based indexes; CUSTOM_INDEX marks the custom entry.
 * Re-asks until the input is valid.
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
    console.log(formatMenu(question, options, opts));
    for (;;) {
      const answer = await promptLine(rl, choicePrompt(entryCount, multiple));
      const parsed = parseSelection(answer, entryCount, multiple);
      if (parsed) {
        return parsed.map((i) =>
          opts.allowCustom && i === customEntry ? CUSTOM_INDEX : i,
        );
      }
      console.log(t("tool.user_input.invalid"));
    }
  } finally {
    rl.close();
  }
}

/**
 * High-level helper used by the question tool.
 * - No options: free-text input, returns [text] or [] when empty.
 * - With options: returns selected labels; custom entry resolves to typed text.
 */
export async function askUser(
  question: string,
  opts: AskUserOptions = {},
): Promise<string[]> {
  const header = [opts.progress, opts.header].filter(Boolean).join(" — ");
  const text = header ? `${header}\n${question}` : question;
  if (!opts.options || opts.options.length === 0) {
    const answer = await askText(text);
    return answer ? [answer] : [];
  }
  const allowCustom = opts.custom ?? true;
  const indexes = await askChoice(text, opts.options, {
    multiple: opts.multiple,
    allowCustom,
  });
  const labels: string[] = [];
  for (const idx of indexes) {
    if (idx === CUSTOM_INDEX) {
      const custom = await askText(t("tool.user_input.custom_prompt"));
      if (custom) labels.push(custom);
    } else {
      labels.push(opts.options[idx].label);
    }
  }
  return labels;
}
