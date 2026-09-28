/**
 * Общий финал ожидания child-процесса: закрывает дублированный `close`-хендлер
 * в verifier / syntax-validator / lint-on-write (один клон на троих по fallow).
 */

/** Выхлоп завершённого процесса: stdout + stderr. */
export interface ChildRunOutput {
  stdout: string;
  stderr: string;
}

/**
 * Резолвит промис раннера на `code === 0`, иначе реджектит обогащённой
 * ошибкой (сообщение + `stdout`/`stderr`/`status` полями). Поведение 1:1
 * с инлайн-версиями: текст сообщения формирует вызывающий.
 */
export function settleChildClose(
  code: number | null,
  stdout: string,
  stderr: string,
  message: string,
  resolve: (out: ChildRunOutput) => void,
  reject: (err: unknown) => void,
): void {
  if (code === 0) {
    resolve({ stdout, stderr });
    return;
  }
  const err: any = new Error(message);
  err.stdout = stdout;
  err.stderr = stderr;
  err.status = code;
  reject(err);
}
