// Код возврата CLI.
//
// Раньше one-shot-команды завершались всегда кодом 0: `config set` с
// несуществующим ключом, `session show` с чужой id или `provider use` с
// неизвестным провайдером выглядели для скрипта как успех (аудит §7.2/§7.3).
import { pc } from "../ui/colors";
import { getDefaultChannel } from "../output";

let exitCode = 0;

/** Задать код возврата (последний вызов побеждает). */
export function setExitCode(code: number): void {
  exitCode = code;
}

/** Текущий код возврата. */
export function currentExitCode(): number {
  return exitCode;
}

/** Сбросить код (начало новой команды). */
export function resetExitCode(): void {
  exitCode = 0;
}

/**
 * Сообщение об ошибке + код возврата 1. Ошибка печатается в stderr, чтобы
 * stdout оставался машинно-читаемым (например, для `--json`).
 */
export function fail(message: string, code = 1): void {
  getDefaultChannel().writeLine(pc.yellow(message), "stderr");
  setExitCode(code);
}
