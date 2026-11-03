/**
 * REST-хендлеры LSP-таблицы и чистые операции над серверами.
 * Вынесено из `settings-api.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../util";
import type { AppConfig } from "../../../config/types";
import { DEFAULT_LSP_CONFIG } from "../../lsp/config";
import { applyFields, asStringArray, isRecord, validTimeout, type FieldApplier } from "./settings-api-fields";
import { handleConfigWrite, type SettingsState } from "./settings-api-write";

/** Итог записи LSP: язык или код ошибки. */
export type LspWriteResult = { ok: true; lang: string } | { ok: false; error: string };

/** Read-форма строки LSP-сервера (секретов в LSP-конфиге нет). */
export interface LspServerView {
  lang: string;
  command: string;
  args?: string[];
  timeout: number;
  autoInstall: boolean;
  enabled: boolean;
}

/** Чистое чтение: таблица LSP-серверов (фолбэк — встроенные дефолты). */
export function listLspServers(config: AppConfig): LspServerView[] {
  const lsp = config.lsp ?? DEFAULT_LSP_CONFIG;
  return Object.entries(lsp.servers).map(([lang, srv]) => {
    const view: LspServerView = {
      lang,
      command: srv.command,
      timeout: srv.timeout ?? lsp.timeout,
      autoInstall: srv.autoInstall ?? false,
      enabled: lsp.enabled !== false && srv.enabled !== false,
    };
    if (srv.args) view.args = [...srv.args];
    return view;
  });
}

/** Пополевые LSP-апплаеры (правило #17: таблица, без `if`-цепочки). */
const LSP_FIELD_APPLIERS: Record<
  string,
  FieldApplier<{ enabled?: boolean; command: string; args?: string[]; timeout?: number }>
> = {
  enabled: (srv, v) => {
    if (typeof v !== "boolean") return "invalid-enabled";
    srv.enabled = v;
    return null;
  },
  command: (srv, v) => {
    if (typeof v !== "string" || !v.trim()) return "invalid-command";
    srv.command = v.trim();
    return null;
  },
  args: (srv, v) => {
    const args = asStringArray(v);
    if (!args) return "invalid-args";
    srv.args = args;
    return null;
  },
  timeout: (srv, v) => {
    if (!validTimeout(v)) return "invalid-timeout";
    srv.timeout = v;
    return null;
  },
};

/** Пополевой LSP-патч; возвращает код ошибки или null. */
function applyLspPatch(
  srv: { enabled?: boolean; command: string; args?: string[]; timeout?: number },
  patch: Record<string, unknown>,
): string | null {
  return applyFields(srv, patch, LSP_FIELD_APPLIERS);
}

/** Чистая правка одного LSP-сервера (секцию `lsp` поднимает из дефолтов, если нет). */
export function updateLspServer(
  config: AppConfig,
  lang: string,
  patch: unknown,
): LspWriteResult {
  if (!isRecord(patch)) return { ok: false, error: "invalid-input" };
  if (!config.lsp) config.lsp = structuredClone(DEFAULT_LSP_CONFIG);
  const srv = config.lsp.servers[lang];
  if (!srv) return { ok: false, error: "not_found" };
  const patchError = applyLspPatch(srv, patch);
  if (patchError) return { ok: false, error: patchError };
  return { ok: true, lang };
}

/** `GET /api/lsp` — таблица LSP-серверов. */
export function handleLspGet(res: ServerResponse, s: SettingsState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, { servers: listLspServers(s.config) });
}

/** `PUT /api/lsp/:lang {enabled?,timeout?,command?,args?}` — правит один LSP-сервер. */
export function handleLspUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  lang: string,
  s: SettingsState,
): void {
  handleConfigWrite(
    req,
    res,
    s,
    (config, rec) => {
      const result = updateLspServer(config, lang, rec);
      if (result.ok) return { ok: true, key: "lsp" };
      return { ok: false, status: result.error === "not_found" ? 404 : 400, error: result.error };
    },
    (config) => ({ servers: listLspServers(config) }),
  );
}
