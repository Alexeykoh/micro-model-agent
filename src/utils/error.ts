/** Извлекает читаемое сообщение из брошенного значения любого типа. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}