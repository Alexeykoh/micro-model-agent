// Короткие писатели в канал: markdown/ошибка/успех/предупреждение.
import { getDefaultChannel } from "../output";
import { formatMarkdown, formatError, formatSuccess, formatWarning } from "./md-formatter";

/** Пишет markdown-текст в stdout. */
export function writeOutput(text: string): void {
  getDefaultChannel().writeRaw(`${formatMarkdown(text)}\n`);
}

/** Пишет ошибку в stderr. */
export function writeError(text: string): void {
  getDefaultChannel().writeRaw(`${formatError(text)}\n`, "stderr");
}

/** Пишет успех в stdout. */
export function writeSuccess(text: string): void {
  getDefaultChannel().writeRaw(`${formatSuccess(text)}\n`);
}

/** Пишет предупреждение блочной строкой. */
export function writeWarning(text: string): void {
  getDefaultChannel().writeLine(formatWarning(text));
}
