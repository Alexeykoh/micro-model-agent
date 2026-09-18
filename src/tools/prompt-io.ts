import {
  formatMenu,
  choicePrompt,
  parseSelection,
  CUSTOM_INDEX,
  type InputOption,
  type AskChoiceOptions,
} from "./user-input";
import { t } from "../i18n/index";

/** Minimal terminal-agnostic prompt surface used by interactive tools. */
export interface PromptIO {
  askText(question: string): Promise<string>;
  askChoice(question: string, options: InputOption[], opts?: AskChoiceOptions): Promise<number[]>;
}

/** Build a PromptIO from injectable ask/print primitives (testable, terminal-agnostic). */
export function createPromptIO(deps: {
  ask: (prompt: string) => Promise<string>;
  print: (line: string) => void;
}): PromptIO {
  return {
    async askText(question) {
      return (await deps.ask(`${question} `)).trim();
    },
    async askChoice(question, options, opts = {}) {
      const multiple = opts.multiple ?? false;
      const entryCount = options.length + (opts.allowCustom ? 1 : 0);
      // No selectable entries (and no custom entry) — parseSelection can never
      // succeed, so return without printing a dead menu or looping forever.
      if (entryCount === 0) return [];
      const customEntry = options.length;
      deps.print(formatMenu(question, options, opts));
      for (;;) {
        const answer = await deps.ask(choicePrompt(entryCount, multiple));
        const parsed = parseSelection(answer, entryCount, multiple);
        if (parsed) {
          return parsed.map((i) => (opts.allowCustom && i === customEntry ? CUSTOM_INDEX : i));
        }
        deps.print(t("tool.user_input.invalid"));
      }
    },
  };
}
