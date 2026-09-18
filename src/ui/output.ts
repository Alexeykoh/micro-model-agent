import { defaultOutputBus } from "../output";
import { formatMarkdown, formatError, formatSuccess, formatWarning } from "./md-formatter";

export function writeOutput(text: string): void {
  defaultOutputBus.emit({
    level: "info",
    source: "",
    kind: "raw",
    text: formatMarkdown(text) + "\n",
  });
}

export function writeError(text: string): void {
  defaultOutputBus.emit({ level: "error", source: "", kind: "log", text: formatError(text) });
}

export function writeSuccess(text: string): void {
  defaultOutputBus.emit({
    level: "info",
    source: "",
    kind: "raw",
    text: formatSuccess(text) + "\n",
  });
}

export function writeWarning(text: string): void {
  defaultOutputBus.emit({ level: "warn", source: "", kind: "log", text: formatWarning(text) });
}
