/**
 * Приведение тела ошибки провайдера к читаемому тексту.
 *
 * Наблюдалось: LM Studio / OpenAI-совместимые бэкенды отдают
 * `{"error": {"message": "...", "type": "...", "param": "model"}}`, а Ollama —
 * `{"error": "строка"}`. `String(parsed.error)` на объекте даёт `[object Object]`:
 * реальная причина («Engine protocol startup was aborted») терялась, и в лог,
 * и в retry-классификацию (`transient-error.ts`), и в текст ошибки сабтаска MoE.
 */

/** Максимальная длина приведённого текста ошибки (обрезается хвост). */
const MAX_ERROR_TEXT = 500;

/** Глубина вложенности, дальше которой разбор прекращается (защита от циклов). */
const MAX_DEPTH = 4;

/** Ключи, в которых провайдеры кладут текст ошибки. */
const TEXT_FIELDS = ["message", "reason", "detail", "type"] as const;

/**
 * Достаёт текст ошибки из произвольного тела ответа провайдера.
 *
 * Поддерживает строку, объект с `message`, вложенный `error.message`,
 * массив строк и любые прочие объекты (тогда — компактный JSON, чтобы поля
 * `param`/`code` не потерялись совсем).
 * @param raw значение поля `error` (или целиком тело ошибки) от провайдера.
 * @returns непустой текст; при полностью нечитаемом значении — `"unknown error"`.
 */
export function extractProviderErrorText(raw: unknown): string {
  const text = extract(raw, 0);
  if (!text) return "unknown error";
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

/** Диспетчер разбора по типу значения. */
function extract(raw: unknown, depth: number): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  // Глубокая вложенность — безопасный фолбэк вместо обхода графа.
  if (depth >= MAX_DEPTH) return "";
  if (Array.isArray(raw)) return joinParts(raw.map((item) => extract(item, depth + 1)));
  if (typeof raw === "object") return fromObject(raw as Record<string, unknown>, depth);
  return "";
}

/** Объект: сперва текстовое поле, затем вложенный `error`, затем компактный JSON. */
function fromObject(obj: Record<string, unknown>, depth: number): string {
  for (const field of TEXT_FIELDS) {
    const value = obj[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (obj.error !== undefined && obj.error !== null) {
    const nested = extract(obj.error, depth + 1);
    if (nested) return nested;
  }
  return toJson(obj);
}

/** Массив ошибок: непустые части через `; ` (Ollama/некоторые прокси). */
function joinParts(parts: string[]): string {
  return parts.filter(Boolean).join("; ");
}

/** Компактный JSON — последний фолбэк, чтобы не потерять `param`/`code`. */
function toJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, MAX_ERROR_TEXT);
  } catch {
    // Циклическая структура: текста нет, но и падать нельзя.
    return "";
  }
}
