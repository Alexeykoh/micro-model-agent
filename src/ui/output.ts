import { formatMarkdown, formatError, formatSuccess, formatWarning } from "./md-formatter";

export function writeOutput(text: string): void {
  process.stdout.write(formatMarkdown(text) + "\n");
}

export function writeError(text: string): void {
  process.stderr.write(formatError(text) + "\n");
}

export function writeSuccess(text: string): void {
  process.stdout.write(formatSuccess(text) + "\n");
}

export function writeWarning(text: string): void {
  process.stdout.write(formatWarning(text) + "\n");
}
