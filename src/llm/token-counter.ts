/**
 * Подсчёт токенов.
 *
 * Использует js-tiktoken (если доступен) для точного подсчёта.
 * Fallback: ~4 символа на токен.
 *
 * Encoding кэшируется как синглтон — создаётся один раз, переиспользуется.
 * Это критично для производительности: на 240 сообщениях разница ~32с vs <1с.
 *
 * @module llm/token-counter
 */

let tiktoken: any = null;
let cachedEncoding: any = null;

async function loadTiktoken(): Promise<void> {
  if (tiktoken) return;
  try {
    const mod = await import('js-tiktoken');
    tiktoken = mod;
  } catch {
    tiktoken = null;
  }
}

function getEncoding(): any {
  if (cachedEncoding) return cachedEncoding;
  if (tiktoken?.encodingForModel) {
    try {
      cachedEncoding = tiktoken.encodingForModel('gpt-4');
    } catch { /* fall through */ }
  }
  return cachedEncoding;
}

export async function countTokens(text: string): Promise<number> {
  await loadTiktoken();
  const enc = getEncoding();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch { /* fall through */ }
  }
  return Math.ceil(text.length / 4);
}

/** Сброс кэша encoding (при смене модели или ошибке) */
export function resetTokenCache(): void {
  cachedEncoding = null;
}
