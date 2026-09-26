/**
 * REST handler for `POST /api/answer` — settles a pending interactive question
 * (`question`/`approve` tools) with the browser's response.
 *
 * Split out of `server.ts` (rule #1: ≤300 lines/file). Auth + same-origin are
 * enforced upstream in `server.ts`; this function assumes both passed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBodyError, sendJson } from "./util";
import { readJsonBody } from "./body";
import { resolveAnswer } from "./prompt-io";
import type { WebUiState } from "./state";

/**
 * Body: `{ id: string, value: unknown }`. `value` is a string for free-text
 * questions and a `number[]` of option indices for choice questions.
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
