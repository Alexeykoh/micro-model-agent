/**
 * Мост «security-события → SSE» (U22). Журнал защиты живёт в
 * `modules/security/security-events` и наполняется из `logAudit` и DLP-диагностик;
 * здесь он переиздаётся SSE-событием `security` для вкладки «Безопасность».
 *
 * Бэкфилл истории — отдельный GET `/api/sessions/:id/security`.
 */
import {
  subscribeSecurityEvents,
  type SecurityEvent,
} from "../../security/security-events";
import { broadcast, type SseTransport } from "../state";

/** Подписать webui на security-события; возвращает отписку. */
export function installSecurityForwarding(state: SseTransport): () => void {
  return subscribeSecurityEvents((event: SecurityEvent) => {
    broadcast(
      {
        type: "security",
        ts: Date.parse(event.ts) || Date.now(),
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        event,
      },
      state,
    );
  });
}
