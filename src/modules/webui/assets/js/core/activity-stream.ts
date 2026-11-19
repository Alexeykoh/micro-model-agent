// SSE → фаза хода. Единственная точка, где фаза меняется: лента («думаю»)
// и рельс («пишу»/«выполняю») читают одно состояние (`activity.ts`) и не
// расходятся между собой.
import { activityNote, activityStop, type ActivityEvent } from "./activity.js";
import type { Dict } from "./store/types.js";

/** Ключ состояния хода: id сессии, которой принадлежит событие. */
export function activityKey(d: Dict): string {
  return typeof d.sessionId === "string" ? d.sessionId : "";
}

/**
 * Подписывает поток SSE на события хода. Вызывается ДО таблицы обработчиков
 * ленты, чтобы фаза обновилась раньше отрисовки.
 */
export function attachActivityStream(
  es: EventSource,
  parse: (e: MessageEvent) => Dict | null,
): void {
  const kinds: Array<[string, ActivityEvent]> = [
    ["text", "text"],
    ["reasoning", "reasoning"],
    ["tool_start", "tool_start"],
    ["tool_end", "tool_end"],
  ];
  for (const [ev, kind] of kinds) {
    es.addEventListener(ev, (e) => {
      const d = parse(e);
      if (d) activityNote(activityKey(d), kind);
    });
  }
  // `phase` несёт «thinking» (модель пошла генерировать) и «done» (генерация
  // закончилась) — после него агент решает, что делать дальше.
  es.addEventListener("phase", (e) => {
    const d = parse(e);
    if (d) activityNote(activityKey(d), d.phase === "thinking" ? "thinking" : "done");
  });
  es.addEventListener("turn_end", (e) => {
    const d = parse(e);
    if (d) activityStop(activityKey(d));
  });
}
