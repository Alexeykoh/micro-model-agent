// `http:`-проверка шага плана: дешёвый runtime-сигнал без браузера.
//
// Формат: `http:<url>` (ожидается 2xx) или `http:<url>~<подстрока>` (2xx и
// подстрока в теле). Редиректы не разыменовываются: проверяем именно тот адрес,
// который назвал агент. Тело читается до HTTP_BODY_CAP, чтобы не тянуть файл.
const HTTP_TIMEOUT_MS = 3000;
const HTTP_BODY_CAP = 256 * 1024;

export interface HttpCheckResult {
  ok: boolean;
  /** HTTP-статус (если ответ получен). */
  status?: number;
  /** Сколько байт прочитано. */
  bytes?: number;
  /** Человеческая причина отказа (для сообщения модели). */
  reason?: string;
}

/** Разбирает цель после `http:` на url и необязательный маркер. */
export function parseHttpTarget(target: string): { url: string; marker?: string } | null {
  const raw = target.trim();
  const sep = raw.indexOf("~");
  const url = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  const marker = sep === -1 ? undefined : raw.slice(sep + 1).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return { url, ...(marker ? { marker } : {}) };
}

/** GET-проверка: 2xx плюс (опционально) маркер в теле. Не бросает. */
export async function runHttpCheck(
  target: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<HttpCheckResult> {
  const parsed = parseHttpTarget(target);
  if (!parsed) return { ok: false, reason: "invalid url (expect http:// or https://)" };

  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(parsed.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    }
    let bytes = 0;
    let text = "";
    if (parsed.marker) {
      const body = await res.text();
      text = body.length > HTTP_BODY_CAP ? body.slice(0, HTTP_BODY_CAP) : body;
      bytes = text.length;
    }
    if (parsed.marker && !text.includes(parsed.marker)) {
      return {
        ok: false,
        status: res.status,
        bytes,
        reason: `marker not found: ${parsed.marker}`,
      };
    }
    return { ok: true, status: res.status, bytes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(msg)) return { ok: false, reason: `timeout ${timeoutMs}ms` };
    return { ok: false, reason: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
