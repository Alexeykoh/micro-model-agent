// DLP-агрегат на границе хода: забрать журнал, персистить, добавить в SSE.
// Вынесено из `turns.ts` (правило ≤300) и тестируется без запуска агента.
import type { SseEvent } from "../state";
import type { SessionManager } from "../../session/index";
import type { EgressTurnSummary } from "../../security/data-policy/types";
import { endEgressTurn } from "../../security/data-policy/turn-journal";

/**
 * Персист DLP-агрегата хода. Fail-open: индикатор не имеет права уронить ход.
 * Пишем в pinned-менеджер раннера, а не в активный: при параллели он чужой.
 */
export function persistEgressTurn(manager: SessionManager, egress: EgressTurnSummary): void {
  try {
    manager.appendLog({
      ts: new Date().toISOString(),
      type: "egress_turn",
      source: "module:security.data-policy",
      module: "security.data-policy",
      egress,
    });
  } catch {
    /* fail-open */
  }
}

/**
 * На `turn_end` забирает агрегат сессии (если ход открывал журнал), пишет
 * `egress_turn` в session.jsonl и возвращает событие с полем `egress`.
 * Остальные события и ходы без журнала проходят без изменений.
 */
export function attachEgressTurn(
  manager: SessionManager,
  sessionId: string,
  ev: SseEvent,
): SseEvent {
  if (ev.type !== "turn_end") return ev;
  const egress = endEgressTurn(sessionId);
  if (!egress) return ev;
  persistEgressTurn(manager, egress);
  return { ...ev, egress };
}
