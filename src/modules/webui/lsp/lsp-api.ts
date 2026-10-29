// API вкладки LSP в `mma web`: диагностика серверов (`/api/lsp/doctor`).
import type { ServerResponse } from "node:http";
import type { WorkspaceStore, SseTransport } from "../state";
import { broadcast } from "../state";
import { sendJson } from "../util";

/**
 * `POST /api/lsp/check-changed` — диагностика изменённых файлов рабочего дерева.
 * Ответ всегда 200 с `ok:false` для «нет git/нет изменений»: панель показывает
 * причину, а не ломается.
 */
export async function handleLspCheckChangedPost(
  res: ServerResponse,
  s: WorkspaceStore & SseTransport,
): Promise<void> {
  if (!s.lspCheckChanged) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return;
  }
  const result = await s.lspCheckChanged();
  if (!result) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return;
  }
  sendJson(res, 200, result);
}

/** `GET /api/lsp/doctor` — последний результат диагностики + флаг активной пробы. */
export function handleLspDoctorGet(res: ServerResponse, s: WorkspaceStore & SseTransport): void {
  if (!s.lspDiagnose) {
    sendJson(res, 503, { error: "unavailable" });
    return;
  }
  const body: Record<string, unknown> = {
    diagnosis: s.lspDoctor ?? null,
    probing: s.lspProbing ?? false,
  };
  // Живые флаги глобальных тумблеров (config.lsp.enabled/offline) для диалога
  // информации во вкладке LSP; без вязанного модуля поле опускается.
  if (s.lspFlags) body.flags = s.lspFlags();
  sendJson(res, 200, body);
}

/**
 * `POST /api/lsp/check` — диагностика одного файла для панели. Путь приходит из
 * браузера: jail и отказы — данными (`ok:false` + `error`), не 500.
 */
export async function handleLspCheckPost(
  raw: Record<string, unknown> | null,
  res: ServerResponse,
  s: WorkspaceStore & SseTransport,
): Promise<void> {
  if (!s.lspCheckFile) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return;
  }
  const body = raw ?? {};
  const path = typeof body.path === "string" ? body.path : "";
  const result = await s.lspCheckFile(path);
  if (!result) {
    sendJson(res, 503, { ok: false, error: "unavailable" });
    return;
  }
  const status = result.ok
    ? 200
    : result.error === "outside-workspace" || result.error === "not-found"
      ? 400
      : 503;
  sendJson(res, status, result);
}

/**
 * `POST /api/lsp/doctor` — single-flight перезапуск диагностики; результат
 * приходит по SSE `lsp` (`start` → `done`/`error`), HTTP не держим (проба может
 * идти до ~45с).
 */
export function handleLspDoctorPost(res: ServerResponse, s: WorkspaceStore & SseTransport): void {
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
