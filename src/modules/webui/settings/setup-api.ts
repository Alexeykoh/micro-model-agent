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
import { getFlatDicts, setLocale } from "../../../i18n/index";
import { applyAnswersToConfig } from "../../setup/apply";
import { SETUP_LANGUAGES, securityDetailFromConfig } from "../../setup/answers";
import { scanLocalServers } from "../../setup/discovery";
import { broadcast } from "../state";
import type { ConfigStore, WorkspaceStore, HttpTransport, SseTransport } from "../state";
import { readBody, requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { persistAndReconfigure } from "../http/persist";
import { handleSetupContext, handleSetupModels, handleSetupTest } from "./setup-probes";
import { parseSetupAnswers } from "../../../runtime/setup-input";

// Валидация ответов визарда живёт в runtime; реэкспорт для существующих импортёров.
export { parseSecurityDetail, parseSetupAnswers } from "../../../runtime/setup-input";

// Пробы провайдера живут в `setup-probes.ts` (у них своя политика:
// rate-limit + SSRF-проверка baseUrl). Реэкспорт для импортёров.
export { handleSetupContext, handleSetupModels, handleSetupTest };

/** `GET /api/setup` — нужен ли сетап, плюс статика визарда. */
export function handleSetupGet(
  res: ServerResponse,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
  const cfg = s.config;
  const defaults = s.setup?.defaults ?? { contextWindow: 0, maxToolIterations: 0 };
  const sounds = cfg?.ui?.sounds ?? {};
  sendJson(res, 200, {
    required: s.setupRequired,
    languages: s.setup?.languages ?? [],
    providers: s.setup?.providers ?? [],
    workspace: s.workspace,
    defaults: {
      ...defaults,
      contextAuto: cfg?.contextAuto !== false,
      ...(cfg?.security ? { security: securityDetailFromConfig(cfg.security) } : {}),
    },
    current: {
      provider: cfg?.provider?.type ?? "",
      apiBase: cfg?.provider?.baseUrl ?? "",
      model: cfg?.model ?? "",
      contextWindow: cfg?.contextWindow ?? defaults.contextWindow,
      contextAuto: cfg?.contextAuto !== false,
      criticEnabled: cfg?.critic?.enabled !== false,
      webSearchEnabled: cfg?.webSearch?.enabled !== false,
      ui: {
        theme: cfg?.ui?.theme ?? "console",
        themeMode: cfg?.ui?.themeMode ?? "auto",
        themeEffects: cfg?.ui?.themeEffects !== false,
        sounds: {
          enabled: sounds.enabled !== false,
          done: sounds.done !== false,
          question: sounds.question !== false,
          failed: sounds.failed !== false,
          volume: typeof sounds.volume === "number" ? sounds.volume : 50,
        },
      },
    },
  });
}

/** `POST /api/setup/scan` — проб известных локальных OpenAI-совместимых серверов. */
export function handleSetupScan(
  req: IncomingMessage,
  res: ServerResponse,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
  readBody(req, s.maxBodyBytes)
    .then(async () => {
      const servers = await scanLocalServers();
      sendJson(res, 200, { servers });
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/** Строковое поле тела (trim); не строка — пустая. */
function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * `POST /api/setup/locale {locale}` — переключает локаль i18n процесса, чтобы
 * следующие шаги визарда локализовались. Не персистится (финал `POST /api/setup`
 * пишет выбранную локаль в конфиг).
 */
export function handleSetupLocale(
  req: IncomingMessage,
  res: ServerResponse,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
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
      requestError(req, res, err);
    });
}

/** `POST /api/setup` — валидация, применение, персист, reconfigure, снятие гейта. */
export function handleSetupPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
): void {
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
      requestError(req, res, err);
    });
}

/** Диспатч `/api/setup*`; возвращает, обработан ли запрос. */
export function handleSetupApi(
  req: IncomingMessage,
  res: ServerResponse,
  reqUrl: URL,
  s: ConfigStore & WorkspaceStore & HttpTransport & SseTransport,
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
