// Автоимена сессий: детерминированное из первого сообщения + LLM-уточнение (fail-open).
import { t } from "../../i18n/index";

const MAX_NAME_LEN = 60;
const MIN_CUT = 20;

/** Детерминированное мгновенное имя сессии из первого сообщения пользователя. */
export function deriveSessionName(input: string, date?: string): string {
  const firstLine = input.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  let s = firstLine
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/^[#>\-*+\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…]+$/u, "")
    .trim();
  if (!s) {
    return t("session.default_name", { date: date ?? new Date().toISOString().slice(0, 10) });
  }
  if (s.length > MAX_NAME_LEN) {
    const cut = s.slice(0, MAX_NAME_LEN);
    const lastSpace = cut.lastIndexOf(" ");
    s = `${(lastSpace > MIN_CUT ? cut.slice(0, lastSpace) : cut).trim()}…`;
  }
  return s;
}

/** Нормализовать заголовок от модели; мусор — null. */
export function sanitizeTitle(raw: string): string | null {
  const first =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const cleaned = first.replace(/^["'«»`]+|["'«»`.!,;:]+$/gu, "").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NAME_LEN ? `${cleaned.slice(0, MAX_NAME_LEN).trim()}…` : cleaned;
}

/** Тип chat-функции для генерации заголовка (инжектится, тестируемо). */
export type TitleChat = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** Собрать промпт заголовка из отрывка сообщения (первые 1000 символов). */
export function buildTitlePrompt(input: string): string {
  const excerpt = input.slice(0, 1000);
  return [
    "Give a short session title for the message below.",
    "Rules: 3-6 words, same language as the message, no quotes, no emoji, no trailing punctuation.",
    "Reply with the title only.",
    "",
    excerpt,
  ].join("\n");
}

/** Разовый LLM-заголовок с таймаутом. Fail-open — любая ошибка даёт null. */
export async function generateSessionTitle(
  input: string,
  chat: TitleChat,
  timeoutMs = 8000,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const raw = await chat(buildTitlePrompt(input), controller.signal);
    return sanitizeTitle(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
