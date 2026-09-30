// REST-хендлеры браузерного визарда первого запуска `mma web`.
// Зеркалят терминальный визард поверх shared ядра `src/modules/setup`: discovery
// (`scan`/`models`/`test`), переключение локали, финальный `POST /api/setup`
// (применить ответы, персист, хот-свап агента).
//
// Гейтинг: пока `state.setupRequired` — чат запрещён (`/api/message`,
// `/api/command` → 409). Повторный `POST /api/setup` после настройки — отказ
// (`409 already_configured`), чтобы протухшая вкладка молча не переконфигурила
// живой инстанс.
//
// Auth и same-origin — выше в `server.ts`. API-ключ принимается, но никогда
// не возвращается назад.
import type { IncomingMessage, ServerResponse } from "node:http";
import { getFlatDicts, setLocale } from "../../i18n";
import { applyAnswersToConfig } from "../setup/apply";
import { SETUP_LANGUAGES, type SetupAnswers } from "../setup/answers";
import { fetchProviderModels, scanLocalServers, testProviderChat } from "../setup/discovery";
import { probeProviderContext } from "../../llm/provider-context";
import { broadcast } from "./state";
import type { WebUiState } from "./state";
import { readBody, readBodyError, sendJson } from "./util";
import { readJsonBody } from "./body";
import { persistAndReconfigure } from "./persist";

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Положительный int, числовая строка принимается; `null` — мусор. */
function positiveInt(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Валидирует тело `POST /api/setup`; `null` — реджект с 400. */
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

/** `GET /api/setup` — нужен ли сетап, плюс статика визарда. */
export function handleSetupGet(res: ServerResponse, s: WebUiState): void {
  sendJson(res, 200, {
    required: s.setupRequired,
    languages: s.setup?.languages ?? [],
    providers: s.setup?.providers ?? [],
    defaults: s.setup?.defaults ?? { contextWindow: 0, maxToolIterations: 0 },
  });
}

/** `POST /api/setup/scan` — проб известных локальных OpenAI-совместимых серверов. */
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

/** `POST /api/setup/models {baseUrl, apiKey}` — id моделей провайдера. */
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

/** `POST /api/setup/test {baseUrl, apiKey, model}` — дешёвый чат-проб. */
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

/** `POST /api/setup/context {baseUrl, apiKey, model, providerType?}` — окно контекста у провайдера. */
export function handleSetupContext(
  req: IncomingMessage,
  res: ServerResponse,
  s: WebUiState,
): void {
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const baseUrl = str(rec, "baseUrl");
      const model = str(rec, "model");
      if (!baseUrl || !model) {
        sendJson(res, 400, { ok: false, error: "invalid-context-request" });
        return;
      }
      const probe = await probeProviderContext(baseUrl, model, {
        apiKey: str(rec, "apiKey") || undefined,
        providerType: str(rec, "providerType") || undefined,
      });
      if (!probe) {
        sendJson(res, 200, { ok: false });
        return;
      }
      sendJson(res, 200, { ok: true, contextWindow: probe.actual, model: probe.model });
    })
    .catch((err: unknown) => {
      readBodyError(req, res, err);
    });
}

/**
 * `POST /api/setup/locale {locale}` — переключает локаль i18n процесса, чтобы
 * следующие шаги визарда локализовались. Не персистится (финал `POST /api/setup`
 * пишет выбранную локаль в конфиг).
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

/** `POST /api/setup` — валидация, применение, персист, reconfigure, снятие гейта. */
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

/** Диспатч `/api/setup*`; возвращает, обработан ли запрос. */
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
  if (p === "/api/setup/context" && req.method === "POST") {
    handleSetupContext(req, res, s);
    return true;
  }
  if (p === "/api/setup/locale" && req.method === "POST") {
    handleSetupLocale(req, res, s);
    return true;
  }
  return false;
}
