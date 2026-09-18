import { getDefaultChannel } from "../output";
import { formatMarkdown, formatError, formatSuccess, formatWarning } from "./md-formatter";

export function writeOutput(text: string): void {
  getDefaultChannel().writeRaw(formatMarkdown(text) + "\n");
}

export function writeError(text: string): void {
  getDefaultChannel().writeRaw(formatError(text) + "\n", "stderr");
}

export function writeSuccess(text: string): void {
  getDefaultChannel().writeRaw(formatSuccess(text) + "\n");
}

export function writeWarning(text: string): void {
  getDefaultChannel().writeLine(formatWarning(text));
}
