// `POST /api/update` — установка доступного апдейта по кнопке в web.
import type { ServerResponse } from "node:http";
import { sendJson } from "../util";

/** Узкая роль: установщик апдейта, без composed-состояния (boundary gate). */
export interface UpdateState {
  updaterInstall?: () => Promise<{ success: boolean; installed?: string; error?: string }>;
}

/**
 * В dev-режиме апдейтер собран, но установка заблокирована
 * (`setInstallEnabled(false)`) — тогда `install()` вернёт `success:false`;
 * здесь это просто пробрасывается в ответ.
 */
export function handleUpdatePost(res: ServerResponse, s: UpdateState): void {
  const install = s.updaterInstall;
  if (!install) {
    sendJson(res, 200, { ok: false, error: "update install is not available in this mode" });
    return;
  }
  install()
    .then((r) => sendJson(res, 200, { ok: r.success, installed: r.installed, error: r.error }))
    .catch((e) => sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }));
}
