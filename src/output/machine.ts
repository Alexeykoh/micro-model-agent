/** Machine-readable output (CLI JSON contracts). The only place with raw stdout. */
export function writeMachineJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Raw stdout write for the non-TTY REPL fallback (documented single-writer exception). */
export function writeNonTtyLine(text: string): void {
  process.stdout.write(`${text}\n`);
}
