// SSE-транспорт веб-модуля: форма события и рассылка клиентам. Отдельный шов,
// чтобы `state.ts` описывал состояние, а не цикл доставки; `state.ts`
// реэкспортирует всё отсюда, поэтому публичная поверхность не меняется.
import type { ServerResponse } from "node:http";

/**
 * Роль: SSE-рассылка (буфер клиентов).
 *
 * Раньше была `Pick<WebUiState, "clients">`; самостоятельная форма нужна, чтобы
 * `broadcast` жил вне god-state. `WebUiState.clients` удовлетворяет ей
 * структурно, поэтому вызовы не меняются.
 */
export interface SseTransport {
  clients: Set<ServerResponse>;
}

/** SSE-событие: тип, время, произвольный пейлоад. */
export interface SseEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

/**
 * Шлёт событие SSE-клиентам с backpressure-дропом зависших.
 *
 * Доставляем КАЖДОЕ событие всем клиентам: одно браузерное окно держит
 * несколько вкладок-сессий, и фоновая вкладка должна стримиться живьём, а не
 * молчать до переключения. Раскладка по вкладкам — на клиенте (`feedForEvent`
 * по `sessionId`). Авто-штампа `activeSessionId` нет: сессионные события несут
 * свой `sessionId` явно, глобальные (`state`/`index`) идут без него.
 */
export function broadcast(ev: SseEvent, s: SseTransport): void {
  const payload = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const client of [...s.clients]) {
    // Backpressure: `false` — буфер сокета полон (медленный/виснущий читатель).
    // Дропаем клиента, а не копим события безгранично.
    try {
      if (!client.write(payload)) {
        s.clients.delete(client);
        client.end();
      }
    } catch {
      s.clients.delete(client);
    }
  }
}
