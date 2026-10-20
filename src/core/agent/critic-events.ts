// Сбор событий тулов текущего захода для evidence-пакета критика.
//
// Вынесено из `critic-gate.ts` (файл был на пределе правила «≤300 строк»).

/** Хвост вывода тула в evidence-событии (ограничен — у критика свой бюджет). */
const MAX_EVENT_OUTPUT_CHARS = 600;

/** Событие тула, видимое критику. */
export interface CriticToolEvent {
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  output?: string;
}

/**
 * Собирает события тулов текущего захода из активной истории (для evidence-пакета критика).
 * @param contextManager менеджер с getActiveHistory;
 * @param fromSeq маркер начала захода (`ContextManager.beginTurn()`): берутся сообщения
 *   со штампом `seq >= fromSeq`. Штамп монотонный и переживает компакцию, поэтому
 *   сжатие истории посреди хода больше не «теряет» улики текущего захода.
 * @returns события role:"tool" начиная с маркера.
 */
export function gatherTurnToolEvents(
  contextManager: {
    getActiveHistory: () => Array<{
      role: string;
      name?: string;
      content?: unknown;
      success?: boolean;
      arguments?: Record<string, unknown>;
      seq?: number;
    }>;
    seqOf?: (msg: object) => number;
  },
  fromSeq = 0,
): CriticToolEvent[] {
  const events: CriticToolEvent[] = [];
  const history = contextManager.getActiveHistory();
  for (const m of history) {
    const seq = contextManager.seqOf ? contextManager.seqOf(m) : (m.seq ?? 0);
    if (seq < fromSeq) continue;
    if (m.role !== "tool" || !m.name) continue;
    // Сообщения role:"tool" уже несут аргументы (tool-batch) и обрезанный
    // вывод — пробрасываем оба, чтобы критик видел ЧТО тронуто и ЧТО вернулось.
    // Без аргументов пакет слеп (changedFiles/commands пусты) и критик
    // вынужден вернуть "ok" за отсутствием улик.
    const output = typeof m.content === "string" ? m.content.slice(-MAX_EVENT_OUTPUT_CHARS) : undefined;
    events.push({ tool: m.name, args: m.arguments, ok: m.success, output });
  }
  return events;
}
