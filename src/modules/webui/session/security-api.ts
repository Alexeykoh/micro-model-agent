/**
 * `GET /api/sessions/:id/security` — журнал защиты сессии (U22).
 *
 * Сама выборка событий переехала в `runtime/security-view.ts` (split W10):
 * её же использует демон, чтобы тонкий клиент видел тот же журнал.
 */
import type { ServerResponse } from "node:http";
import {
  clampSecurityLimit,
  MAX_SECURITY_LIMIT,
  mergeSecurityEvents,
} from "../../../runtime/security-view";
import { sendJson } from "../util";

export { mergeSecurityEvents } from "../../../runtime/security-view";

/** Обработать запрос журнала защиты. */
export function handleSessionSecurity(
  res: ServerResponse,
  sessionId: string,
  rawLimit?: string | null,
  sessionDir?: string,
): void {
  const limit = clampSecurityLimit(rawLimit);
  sendJson(res, 200, { events: mergeSecurityEvents(sessionId, limit, sessionDir), cap: MAX_SECURITY_LIMIT });
}
