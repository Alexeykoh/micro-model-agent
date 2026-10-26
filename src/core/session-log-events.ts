// События журнала с каналом (`tool`): план и директивы харнесса.
import type { SessionLogEntry } from "../modules/session/store";

/** Тип записи журнала сессии, которая несёт канал в поле `tool`. */
type ChannelEventType = "plan" | "directive";

/**
 * Запись события с каналом и итерацией.
 *
 * Канал `plan` — только жизненный цикл плана; предупреждения execution-модуля
 * и инъекции харнесса идут в `directive`, иначе при разборе «почему агент так
 * поступил» в журнале нет того, что ему сказали (spec
 * 2026-10-26-session-directive-log-design).
 *
 * @param type тип события; @param event канал; @param detail текст;
 * @param iteration итерация хода (опускается, если неизвестна).
 */
export function toolChannelEvent(
  type: ChannelEventType,
  event: string,
  detail: string,
  iteration?: number,
): Omit<SessionLogEntry, "ts" | "source"> {
  return {
    type,
    content: detail,
    tool: event,
    ...(iteration !== undefined ? { iteration } : {}),
  };
}
