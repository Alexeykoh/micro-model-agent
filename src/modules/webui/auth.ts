/**
 * Аутентификация и заголовки безопасности `mma web` (правило ≤300 строк).
 *
 * Вынесено из `util.ts`: токен-auth (заголовок/query/кука), HttpOnly-кука для
 * plain-навигаций, same-origin проверка и статические security-заголовки.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Сравнение строк за константное время; разные длины коротко замыкаются (timingSafeEqual бросает). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Имя HttpOnly-куки, несущей веб-токен для GET-навигаций. */
const AUTH_COOKIE = "mma_web_auth";

/** Читает значение куки из сырого заголовка `Cookie:`; битые кодировки дают null. */
function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Заголовки безопасности веб-поверхности (аудит §6.1): фрейминг, MIME-sniffing,
 * referrer и CSP.
 *
 * `script-src` содержит `'unsafe-inline'` — в `index.html` есть инлайновый
 * bootstrap темы; без него тема мигает при загрузке. Вынос скрипта в файл
 * позволит сузить политику — это `DEBT(webui-csp-inline-script)`.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; "),
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Узкий срез состояния для auth-проверок: только токен. */
export interface AuthState {
  token: string | null | undefined;
}

/** Токен-auth HTTP-поверхностей (заголовок `x-mma-token`, `?token=` или кука); без токена — разрешено. */
export function checkAuth(req: IncomingMessage, reqUrl: URL, s: AuthState): boolean {
  if (!s.token) return true;
  const header = req.headers["x-mma-token"];
  if (typeof header === "string" && safeEqual(header, s.token)) return true;
  const query = reqUrl.searchParams.get("token");
  if (query !== null && safeEqual(query, s.token)) return true;
  const cookie = cookieValue(req.headers.cookie, AUTH_COOKIE);
  return cookie !== null && safeEqual(cookie, s.token);
}

/**
 * Выдаёт браузеру same-site куку с токеном, чтобы plain-навигация
 * `<a target="_blank" href="/api/file?...">` (не умеющая ставить заголовок
 * `x-mma-token`) всё равно аутентифицировалась. `SameSite=Strict` — кросс-сайт
 * запрос её никогда не несёт, так что CSRF-поверхности не добавляется.
 */
export function setAuthCookie(res: ServerResponse, s: AuthState): void {
  if (!s.token) return;
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE}=${encodeURIComponent(s.token)}; Path=/; HttpOnly; SameSite=Strict`,
  );
}

/** Отклоняет кросс-доменные записи из браузера (CSRF-закалка). */
export function sameOrigin(req: IncomingMessage, reqUrl: URL): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / same-origin GET
  try {
    return new URL(String(origin)).host === reqUrl.host;
  } catch {
    return false;
  }
}
