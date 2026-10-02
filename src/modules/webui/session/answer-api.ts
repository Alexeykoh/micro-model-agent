// REST-хендлер `POST /api/answer`: закрывает висящий интерактивный вопрос ответом браузера.
/**
 * Вынесен из `server.ts` (правило #1: ≤300 строк/файл). Auth и same-origin
 * проверяются выше в `server.ts`; здесь оба считаются пройденными.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBodyError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { resolveAnswer } from "./prompt-io";
import type { WebUiState } from "../state";

/**
 * Тело: `{ id: string, value: unknown }`. `value` — строка для free-text
 * вопросов и `number[]` индексов опций для вопросов с выбором.
 */
export function handleAnswerPost(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { error: "invalid body" });
        return;
      }
      const id = typeof rec.id === "string" ? rec.id : "";
      if (!id) {
        sendJson(res, 400, { error: "invalid body" });
        return;
      }
      if (!resolveAnswer(s, id, rec.value)) {
        sendJson(res, 404, { error: "unknown id" });
        return;
      }
      sendJson(res, 200, { ok: true });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}
