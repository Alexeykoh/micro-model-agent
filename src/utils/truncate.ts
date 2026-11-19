/**
 * Обрезка строки с многоточием. Раньше жила приватной в context/manager.ts
 * и переписывалась инлайном в openai-compat и mcp/client.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/**
 * Обрезка ПО СЛОВАМ с многоточием: длинное описание не режется посреди слова.
 * Нужна там, где текст читает человек или модель (описание скилла в
 * системном промпте).
 */
export function truncateWords(s: string, max: number): string {
  const text = s.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const head = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${head}…`;
}