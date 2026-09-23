/**
 * REST handler for the i18n surface of `mma web`.
 *
 * The browser localizes its own static chrome from a dictionary served here;
 * model/tool output stays localized server-side. Split out of `server.ts`
 * (rule #1: ≤300 lines/file). Auth + same-origin are enforced upstream.
 */
import type { ServerResponse } from "node:http";
import { getFlatDicts } from "../../i18n";
import { sendJson } from "./util";
import type { WebUiState } from "./state";

/** `GET /api/i18n` — current config locale + all flattened dictionaries. */
export function handleI18nGet(res: ServerResponse, s: WebUiState): void {
  sendJson(res, 200, {
    locale: s.config?.locale ?? "en",
    dicts: getFlatDicts(),
  });
}
