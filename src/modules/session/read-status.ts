/**
 * Результат чтения сессионного файла (INV-15): «пусто» и «не прочитано» —
 * разные состояния. Раньше `null`/`[]` от нижнего слоя означали и то, и другое,
 * поэтому повреждённый журнал выглядел как пустая сессия.
 */
export type SessionRead<T> =
  | { status: "ok"; value: T; truncated?: boolean }
  | { status: "missing" }
  | { status: "unreadable"; cause: string };

/** Человеческая причина из исключения. */
export function readCause(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
