/**
 * Обрезка строки с многоточием. Раньше жила приватной в context/manager.ts
 * и переписывалась инлайном в openai-compat и mcp/client.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}