// Пробы провайдера из визарда: список моделей, дешёвый чат-проб, окно контекста.
//
// Вынесено из `setup-api.ts`: у проб своя политика (rate-limit + SSRF-проверка
// baseUrl), и держать её рядом с финальным `POST /api/setup` незачем.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchProviderModels, testProviderChat } from "../../setup/discovery";
import { probeProviderContext } from "../../../llm/provider-context";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { allowSetupProbe, validateProviderBaseUrl } from "./setup-policy";
import type { ConfigStore, WorkspaceStore, HttpTransport, SseTransport } from "../state";

/** Состояние, нужное пробам: конфиг, транспорт. */
type ProbeState = ConfigStore & WorkspaceStore & HttpTransport & SseTransport;

/** Строка из тела запроса. */
function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Ключ rate-limit: удалённый адрес клиента + маршрут (лимит на каждый). */
function clientKey(req: IncomingMessage, route: string): string {
  return `${req.socket?.remoteAddress ?? "unknown"}:${route}`;
}

/**
 * Общий гард проб провайдера: rate-limit + SSRF-проверка baseUrl.
 *
 * @returns true, если пробу можно продолжать (иначе ответ уже отправлен).
 */
async function guardProbe(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  route: string,
): Promise<boolean> {
  if (!allowSetupProbe(clientKey(req, route))) {
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

/** `POST /api/setup/models {baseUrl, apiKey}` — id моделей провайдера. */
export function handleSetupModels(req: IncomingMessage, res: ServerResponse, s: ProbeState): void {
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
      if (!(await guardProbe(req, res, baseUrl, "models"))) return;
      const models = await fetchProviderModels(baseUrl, str(rec, "apiKey"));
      sendJson(res, 200, { models });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/** `POST /api/setup/test {baseUrl, apiKey, model}` — дешёвый чат-проб. */
export function handleSetupTest(req: IncomingMessage, res: ServerResponse, s: ProbeState): void {
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
      if (!(await guardProbe(req, res, baseUrl, "test"))) return;
      const ok = await testProviderChat(baseUrl, str(rec, "apiKey"), model);
      sendJson(res, 200, { ok });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/** `POST /api/setup/context {baseUrl, apiKey, model, providerType?}` — окно контекста у провайдера. */
export function handleSetupContext(req: IncomingMessage, res: ServerResponse, s: ProbeState): void {
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
      if (!(await guardProbe(req, res, baseUrl, "context"))) return;
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
      requestError(req, res, err);
    });
}
