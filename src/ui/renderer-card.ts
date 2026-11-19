// Состояние карточки тула, пока действие не закрыто футером (шов `renderer.ts`).
import { recordToolAction } from "./action-log";

export interface CardState {
  tool: string;
  args: Record<string, unknown>;
  start: number;
  label: string;
  summary: string;
  /** Leading mark for the action line (◇ or a caller-supplied icon). */
  mark: string;
  /** In quiet mode the header is deferred and folded into the footer line. */
  deferred: boolean;
  /** First non-empty body line, kept for failure reporting in quiet mode. */
  firstBody: string;
  /** Full captured body lines (for Ctrl+O reprint). */
  body: string[];
}

/** Запоминает действие для допечатки по `Ctrl+O` (живёт дольше прогона). */
export function recordCard(
  card: CardState | null,
  label: string,
  summary: string,
  error: boolean | undefined,
  durationMs: number,
): void {
  recordToolAction({
    tool: card?.tool ?? "",
    label,
    summary,
    error,
    durationMs,
    firstBody: card?.firstBody ?? "",
    body: card?.body ?? [],
  });
}
