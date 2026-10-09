/**
 * Discovery-маршруты контракта: `GET /v1/openapi.json` (машинная спека) и
 * `GET /v1/docs` (человеческая страница). Оба без bearer-токена — это описание
 * публичного API, а не данные тенанта (см. exempt-список в `server.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readMmaVersion } from "../../../core/version";
import { buildOpenApiDocument } from "../openapi/document";
import { renderDocsPage } from "../openapi/docs-page";
import type { AgentServiceState } from "../state";

/** `GET /v1/openapi.json` — OpenAPI 3.1 документ текущего рантайма. */
export function handleOpenApiDocument(
  _req: IncomingMessage,
  res: ServerResponse,
  _reqUrl: URL,
  s: AgentServiceState,
): void {
  const doc = buildOpenApiDocument({
    version: readMmaVersion(),
    authRequired: Boolean(s.token),
  });
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    // Спецификация меняется с версией рантайма, но не по запросу: короткий кэш
    // достаточно, чтобы прокси не превращали её в трафик на каждый poll.
    "Cache-Control": "public, max-age=60",
  });
  res.end(JSON.stringify(doc));
}

/** `GET /v1/docs` — человеческая шпаргалка (тот же контракт, читаемый). */
export function handleApiDocs(
  _req: IncomingMessage,
  res: ServerResponse,
  _reqUrl: URL,
  s: AgentServiceState,
): void {
  const html = renderDocsPage({ version: readMmaVersion(), authRequired: Boolean(s.token) });
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "Cache-Control": "public, max-age=60",
  });
  res.end(html);
}
