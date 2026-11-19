/**
 * Визард первого запуска через host wire (split W11): применение ответов,
 * пробы провайдера, скан локальных серверов и переключение локали.
 *
 * Логика проб/валидации общая с web (`runtime/setup-input`, `runtime/setup-policy`,
 * `modules/setup/*`), поэтому визард в daemon-режиме ведёт себя так же.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { setLocale } from "../../../i18n/index";
import { applyAnswersToConfig } from "../../../modules/setup/apply";
import {
  scanLocalServers,
  fetchProviderModels,
  testProviderChat,
} from "../../../modules/setup/discovery";
import { probeProviderContext } from "../../../llm/provider-context";
import { persistAndReconfigure } from "../../../runtime/persist-config";
import { parseSetupAnswers } from "../../../runtime/setup-input";
import { allowSetupProbe, validateProviderBaseUrl } from "../../../runtime/setup-policy";
import { readJsonBodyOrProblem, sendJson } from "../http/respond";
import { emitAllSessions } from "../runtime/emit";
import type { AgentServiceState } from "../state";

const MAX_JSON_BYTES = 1024 * 1024;

/** Обрабатывает `/v1/host/setup/<action>`; `false` — путь не наш. */
export async function handleHostSetupWrite(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
  parts: string[],
): Promise<boolean> {
  if (parts[2] !== "setup" || req.method !== "POST") return false;
  if (parts.length === 3) return apply(req, res, s);
  const action = parts[3];
  if (action === "scan") return scan(res);
  if (action === "locale") return locale(req, res);
  if (action === "models") return models(req, res);
  if (action === "test") return test(req, res);
  if (action === "context") return context(req, res);
  return false;
}

/** `POST /v1/host/setup` — применить ответы, персист, reconfigure. */
async function apply(
  req: IncomingMessage,
  res: ServerResponse,
  s: AgentServiceState,
): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const answers = parseSetupAnswers(body);
  if (!answers) {
    sendJson(res, 400, { ok: false, error: "invalid-answers" });
    return true;
  }
  applyAnswersToConfig(s.config, answers);
  setLocale(s.config.locale);
  const { persisted, warning } = await persistAndReconfigure(
    { saveConfig: s.deps.saveConfig, reconfigure: s.deps.reconfigure, busy: s.pool.anyBusy() },
    s.config,
  );
  emitAllSessions(s, "setup_done", {});
  sendJson(res, 200, { ok: true, persisted, ...(warning ? { warning } : {}) });
  return true;
}

/** `POST /v1/host/setup/scan` — известные локальные OpenAI-совместимые серверы. */
async function scan(res: ServerResponse): Promise<boolean> {
  sendJson(res, 200, { servers: await scanLocalServers() });
  return true;
}

/** `POST /v1/host/setup/locale {locale}` — локаль процесса (не персистится). */
async function locale(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const value = typeof body.locale === "string" ? body.locale.trim() : "";
  if (!value) {
    sendJson(res, 400, { ok: false, error: "unsupported-locale" });
    return true;
  }
  setLocale(value);
  sendJson(res, 200, { ok: true, locale: value });
  return true;
}

/** Гард проб: rate-limit + SSRF-проверка baseUrl (как у web). */
async function guard(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  route: string,
): Promise<boolean> {
  if (!allowSetupProbe(`${req.socket?.remoteAddress ?? "unknown"}:${route}`)) {
    sendJson(res, 429, { ok: false, error: "rate_limited" });
    return false;
  }
  const urlError = await validateProviderBaseUrl(baseUrl);
  if (urlError) {
    sendJson(res, 400, { ok: false, error: urlError });
    return false;
  }
  return true;
}

/** `POST /v1/host/setup/models {baseUrl, apiKey}` — id моделей провайдера. */
async function models(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  if (!baseUrl) {
    sendJson(res, 400, { ok: false, error: "invalid-base-url" });
    return true;
  }
  if (!(await guard(req, res, baseUrl, "models"))) return true;
  const list = await fetchProviderModels(baseUrl, typeof body.apiKey === "string" ? body.apiKey : "");
  sendJson(res, 200, { models: list });
  return true;
}

/** `POST /v1/host/setup/test {baseUrl, apiKey, model}` — дешёвый чат-проб. */
async function test(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!baseUrl || !model) {
    sendJson(res, 400, { ok: false, error: "invalid-test-request" });
    return true;
  }
  if (!(await guard(req, res, baseUrl, "test"))) return true;
  const ok = await testProviderChat(
    baseUrl,
    typeof body.apiKey === "string" ? body.apiKey : "",
    model,
  );
  sendJson(res, 200, { ok });
  return true;
}

/** `POST /v1/host/setup/context {baseUrl, apiKey, model}` — окно контекста. */
async function context(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readJsonBodyOrProblem(req, res, MAX_JSON_BYTES);
  if (!body) return true;
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!baseUrl || !model) {
    sendJson(res, 400, { ok: false, error: "invalid-context-request" });
    return true;
  }
  if (!(await guard(req, res, baseUrl, "context"))) return true;
  const probe = await probeProviderContext(baseUrl, model, {
    apiKey: typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined,
    providerType:
      typeof body.providerType === "string" && body.providerType ? body.providerType : undefined,
  });
  if (!probe) {
    sendJson(res, 200, { ok: false });
    return true;
  }
  sendJson(res, 200, { ok: true, contextWindow: probe.actual, model: probe.model });
  return true;
}
