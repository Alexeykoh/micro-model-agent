// API вкладки LSP в `mma web`: диагностика серверов (`/api/lsp/doctor`).
import type { ServerResponse } from "node:http";
import type { WebUiState } from "../state";
import { broadcast } from "../state";
import { sendJson } from "../util";

/** `GET /api/lsp/doctor` — последний результат диагностики + флаг активной пробы. */
export function handleLspDoctorGet(res: ServerResponse, s: WebUiState): void {
  if (!s.lspDiagnose) {
    sendJson(res, 503, { error: "unavailable" });
    return;
  }
  sendJson(res, 200, { diagnosis: s.lspDoctor ?? null, probing: s.lspProbing ?? false });
}

/**
 * `POST /api/lsp/doctor` — single-flight перезапуск диагностики; результат
 * приходит по SSE `lsp` (`start` → `done`/`error`), HTTP не держим (проба может
 * идти до ~45с).
 */
export function handleLspDoctorPost(res: ServerResponse, s: WebUiState): void {
  if (!s.lspDiagnose) {
    sendJson(res, 503, { error: "unavailable" });
    return;
  }
  if (s.lspProbing) {
    sendJson(res, 202, { ok: true, probing: true });
    return;
  }
  const diagnose = s.lspDiagnose;
  s.lspProbing = true;
  broadcast({ type: "lsp", ts: Date.now(), phase: "start" }, s);
  Promise.resolve(diagnose())
    .then((diagnosis) => {
      s.lspDoctor = diagnosis;
      broadcast({ type: "lsp", ts: Date.now(), phase: "done" }, s);
    })
    .catch(() => {
      broadcast({ type: "lsp", ts: Date.now(), phase: "error" }, s);
    })
    .finally(() => {
      s.lspProbing = false;
    });
  sendJson(res, 202, { ok: true });
}
