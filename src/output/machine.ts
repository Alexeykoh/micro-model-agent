// Машиночитаемый вывод (JSON-контракты CLI). Единственное место с raw stdout.
/** Пишет JSON в stdout (контракт `--json`). @param value любой сериализуемый объект. */
export function writeMachineJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Строка в stdout для non-TTY фолбэка REPL (оговорённое исключение single-writer). */
export function writeNonTtyLine(text: string): void {
  process.stdout.write(`${text}\n`);
}
