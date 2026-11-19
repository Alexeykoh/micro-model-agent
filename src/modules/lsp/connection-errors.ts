// Ошибки LSP-соединения: `fatal` — соединение мертво, переиспользовать нельзя.
//
// Вынесено из `connection.ts` (правило 6): и транспорт, и реестр документов
// бросают одну и ту же ошибку.

/** Ошибка соединения. `fatal` — соединение мертво, переиспользовать нельзя. */
export type LspConnectionError = Error & { fatal?: boolean };

export function fatalError(message: string): LspConnectionError {
  const error = new Error(message) as LspConnectionError;
  error.fatal = true;
  return error;
}
