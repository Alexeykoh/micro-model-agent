/** RCV-5: границы recovery-сабагента. */
/** Повторов ошибки одного тула до вызова сабагента. */
export const RECOVERY_AFTER_FAILURES = 2;
/** Максимум попыток на одну сигнатуру за ход. */
export const RECOVERY_MAX_PER_SIGNATURE = 2;
/** Максимум попыток за ход. */
export const RECOVERY_MAX_PER_TURN = 4;
/** Таймаут одного вызова сабагента, мс. */
export const RECOVERY_TIMEOUT_MS = 20000;
/** Потолок токенов ответа сабагента. */
export const RECOVERY_MAX_TOKENS = 1024;
/** Максимум символов ошибки в промпте сабагента. */
export const RECOVERY_ERROR_CHARS = 2000;
