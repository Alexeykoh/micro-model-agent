/**
 * REST handlers for the browser first-run setup wizard of `mma web`.
 *
 * Mirrors the terminal wizard on top of the shared core in `src/modules/setup`:
 * discovery (`scan`/`models`/`test`), process locale switching, and the final
 * `POST /api/setup` which applies the answers, persists and hot-swaps the agent.
 *
 * Gating: while `state.setupRequired` is true the server refuses chat
 * (`/api/message`, `/api/command` → 409). `POST /api/setup` refuses to run again
 * once setup is done (`409 already_configured`), so a stale tab cannot silently
 * reconfigure a live instance.
 *
 * Auth + same-origin are enforced upstream in `server.ts`; these functions
 * assume the request already passed both checks. The API key is accepted but
 * never echoed back.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getFlatDicts, setLocale } from "../../i18n";
import { applyAnswersToConfig } from "../setup/apply";
import { SETUP_LANGUAGES, type SetupAnswers } from "../setup/answers";
import {
  fetchProviderModels,
  scanLocalServers,
  testProviderChat,
} from "../setup/discovery";
import { broadcast } from "./state";
import type { WebUiState } from "./state";
import { readBody, readBodyError, sendJson } from "./util";
import { readJsonBody } from "./body";
import { persistAndReconfigure } from "./persist";

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Positive integer, accepting a numeric string; `null` when invalid. */
function positiveInt(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Validate the `POST /api/setup` body; `null` means "reject with 400". */
export function parseSetupAnswers(rec: Record<string, unknown>): SetupAnswers | null {
  const provider = str(rec, "provider");
  const apiBase = str(rec, "apiBase");
  const model = str(rec, "model");
  if (!provider || !apiBase || !model) return null;

  const contextWindow = positiveInt(rec, "contextWindow");
  const maxToolIterations = positiveInt(rec, "maxToolIterations");
  if (contextWindow === null || maxToolIterations === null) return null;

  const locale = str(rec, "locale");
  if (!SETUP_LANGUAGES.some((l) => l.value === locale)) return null;

  const flags = ["securityBashBlock", "securityFlagsBlock", "securityPathsRestrict"] as const;
  for (const key of flags) {
    if (typeof rec[key] !== "boolean") return null;
  }

  const apiKey = typeof rec.apiKey === "string" && rec.apiKey.trim() ? rec.apiKey.trim() : "not-needed";
  return {
    provider,
    apiBase,
    apiKey,
    model,
    contextWindow,
    maxToolIterations,
    locale,
    securityBashBlock: rec.securityBashBlock as boolean,
    securityFlagsBlock: rec.securityFlagsBlock as boolean,
    securityPathsRestrict: rec.securityPathsRestrict as boolean,
  };
}

/** `GET /api/setup` — whether setup is required plus static display data. */
export function handleSetupGet(res: ServerResponse, s: WebUiState): void {
  sendJson(res, 200, {
    required: s.setupRequired,
    languages: s.setup?.languages ?? [],
    providers: s.setup?.providers ?? [],
    defaults: s.setup?.defaults ?? { contextWindow: 0, maxToolIterations: 0 },
  });
}

/** `POST /api/setup/scan` — probe well-known local OpenAI-compatible servers. */
export function handleSetupScan(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  readBody(req, s.maxBodyBytes)
    .then(async () => {
      const servers = await scanLocalServers();
      sendJson(res, 200, { servers });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `POST /api/setup/models {baseUrl, apiKey}` — list model ids from a provider. */
export function handleSetupModels(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const baseUrl = str(rec, "baseUrl");
      if (!baseUrl) {
        sendJson(res, 400, { ok: false, error: "invalid-base-url" });
        return;
      }
      const models = await fetchProviderModels(baseUrl, str(rec, "apiKey"));
      sendJson(res, 200, { models });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `POST /api/setup/test {baseUrl, apiKey, model}` — cheap chat probe. */
export function handleSetupTest(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const baseUrl = str(rec, "baseUrl");
      const model = str(rec, "model");
      if (!baseUrl || !model) {
        sendJson(res, 400, { ok: false, error: "invalid-test-request" });
        return;
      }
      const ok = await testProviderChat(baseUrl, str(rec, "apiKey"), model);
      sendJson(res, 200, { ok });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/**
 * `POST /api/setup/locale {locale}` — switch the process i18n locale so the
 * following wizard steps are localized. Not persisted (the final `POST
 * /api/setup` writes the chosen locale into the config).
 */
export function handleSetupLocale(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const locale = str(rec, "locale");
      if (!SETUP_LANGUAGES.some((l) => l.value === locale)) {
        sendJson(res, 400, { ok: false, error: "unsupported-locale" });
        return;
      }
      setLocale(locale);
      sendJson(res, 200, { ok: true, locale, dicts: getFlatDicts() });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** `POST /api/setup` — validate, apply, persist, reconfigure, ungate. */
export function handleSetupPost(req: IncomingMessage, res: ServerResponse, s: WebUiState): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  if (!s.setupRequired) {
    sendJson(res, 409, { error: "already_configured" });
    return;
  }
  const config = s.config;
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const answers = parseSetupAnswers(rec);
      if (!answers) {
        sendJson(res, 400, { ok: false, error: "invalid-answers" });
        return;
      }

      applyAnswersToConfig(config, answers);
      setLocale(config.locale);

      const { persisted, warning } = await persistAndReconfigure(s, config);

      s.setupRequired = false;
      broadcast({ type: "setup_done", ts: Date.now() }, s);

      const body: Record<string, unknown> = { ok: true, persisted };
      if (warning) body.warning = warning;
      sendJson(res, 200, body);
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/** Dispatch `/api/setup*`; returns whether the request was handled. */
export function handleSetupApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: WebUiState,
): boolean {
  const p = reqUrl.pathname;
  if (p === "/api/setup" && req.method === "GET") {
    handleSetupGet(res, s);
    return true;
  }
  if (p === "/api/setup" && req.method === "POST") {
    handleSetupPost(req, res, s);
    return true;
  }
  if (p === "/api/setup/scan" && req.method === "POST") {
    handleSetupScan(req, res, s);
    return true;
  }
  if (p === "/api/setup/models" && req.method === "POST") {
    handleSetupModels(req, res, s);
    return true;
  }
  if (p === "/api/setup/test" && req.method === "POST") {
    handleSetupTest(req, res, s);
    return true;
  }
  if (p === "/api/setup/locale" && req.method === "POST") {
    handleSetupLocale(req, res, s);
    return true;
  }
  return false;
}
