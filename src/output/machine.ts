/** Machine-readable output (CLI JSON contracts). The only place with raw stdout. */
export function writeMachineJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
