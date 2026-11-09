/**
 * OAuth 2.1 (P1 supply-chain 2/2): per-user токен MCP HTTP-серверов.
 * Токен хранится в `oauth.tokenFile` (plain JSON, процессом), при
 * истечении — refresh на `tokenUrl` (refresh_token grant),
 * подстановка `Authorization: Bearer …`. Per-user границы — процессно
 * локальный файл (silo-модель 1 процесс = 1 пользователь).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";

export interface OAuthConfig {
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  tokenFile?: string;
}

interface TokenFile {
  access?: string;
  refreshToken?: string;
  expiresAt?: string;
}

/** Резолвит путь токен-файла (относительно baseDir → абсолютный; иначе запись из конфига). */
export function resolveTokenFile(config: { oauth?: OAuthConfig }, baseDir?: string): string | null {
  const raw = config.oauth?.tokenFile;
  if (!raw) return null;
  if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) return raw;
  return resolve(baseDir ?? process.cwd(), raw);
}

function readTokenFile(path: string): TokenFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TokenFile;
  } catch {
    return {};
  }
}

function writeTokenFile(path: string, token: TokenFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(token, null, 2), "utf-8");
}

function tokenExpired(token: TokenFile): boolean {
  if (!token.access) return true;
  if (!token.expiresAt) return false;
  const exp = Date.parse(token.expiresAt);
  if (!Number.isFinite(exp)) return true;
  return exp <= Date.now();
}

/** Refresh access-токена (fail-open: ошибка → токен не трогается). */
export async function refreshToken(tokenFile: string, tokenUrl: string, clientId = ""): Promise<string | null> {
  const current = readTokenFile(tokenFile);
  if (!current.refreshToken) return null;
  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        ...(clientId ? { client_id: clientId } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
    if (!data.access_token) return null;
    writeTokenFile(tokenFile, {
      access: data.access_token,
      refreshToken: data.refresh_token ?? current.refreshToken,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
    });
    return data.access_token;
  } catch {
    return null;
  }
}

/**
 * Заголовки запроса с `Bearer` (обновляет при истечении/401 — вызывающий
 * зовёт `refreshToken`/`forceRefresh` при 401).
 */
export async function oauthHeaders(
  config: { oauth?: OAuthConfig },
  baseDir?: string,
): Promise<Record<string, string>> {
  const oauth = config.oauth;
  if (!oauth?.tokenUrl) return {};
  const path = resolveTokenFile(config, baseDir);
  if (!path) return {};
  let token = readTokenFile(path);
  if (tokenExpired(token)) {
    const fresh = await refreshToken(path, oauth.tokenUrl, oauth.clientId ?? "");
    if (fresh) token = readTokenFile(path);
  }
  return token.access ? { Authorization: `Bearer ${token.access}` } : {};
}
