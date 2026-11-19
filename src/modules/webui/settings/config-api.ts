// REST-хендлеры поверхностей конфига/модели `mma web` (вынесены из server.ts).
// Отсутствующий коллаборатор — пробел wiring, такие точки отвечают 503, не крашатся.
// Auth и same-origin проверяются выше в `server.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { setLocale } from "../../../i18n/index";
import { serializeConfigForWire } from "../../../config/redact";
import { resolveConfigKey, setConfigValue } from "../../../config/registry";
import { buildConfigRegistry } from "../../../runtime/config-view";
export { buildConfigRegistry, type ConfigRegistryEntry } from "../../../runtime/config-view";
import { configVersion } from "../../../config/persist";
import { needsRebuild } from "../../../config/effects";
import type { AppConfig } from "../../../config/types";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { persistAndReconfigure } from "../http/persist";
import { applyAutoContext, type AutoContextResult } from "./context-auto";
import { rawFromValue } from "../../../cli/config-mutations";
import { buildReasoningView } from "./reasoning-view";
import { capabilitiesBody } from "./capabilities-body";
import type {
  ConfigStore,
  RuntimeState,
  HttpTransport,
  SseTransport,
  WorkspaceStore,
} from "../state";
import { broadcast } from "../state";

/**
 * Ключи, которые можно писать во время хода. У них `effects: []` — reconfigure
 * живого раннера не запускается, риска из аудита §7.9 нет. Сейчас это тема
 * веб-UI: пользователь переключает оформление и во время ответа модели, и
 * терять выбор (409) из-за этого нельзя (INV-T3 спеки
 * `2026-10-30-webui-theme-persistence-design.md`).
 */
const BUSY_EXEMPT_KEYS: ReadonlySet<string> = new Set(["ui.theme", "ui.themeMode"]);

/** Маскирует секрет для показа: последние 4 символа видны, остальное скрыто. */
function maskToken(token: string | null): string | null {
  if (!token) return null;
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

/** `GET /api/config` — отредактированный живой конфиг + реестр ключей. */
export function handleConfigGet(
  res: ServerResponse,
  s: ConfigStore & RuntimeState & HttpTransport & SseTransport,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  sendJson(res, 200, {
    config: serializeConfigForWire(s.config),
    registry: buildConfigRegistry(s.config),
    version: configVersion(s.config),
    webToken: maskToken(s.token),
  });
}

/** Коэрсит JSON-`value` в сырую строку для `setConfigValue`. */
function toRawValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Сырое представление ТЕКУЩЕГО значения ключа (для отката). */
function previousConfigRaw(config: AppConfig, key: string): string {
  const def = resolveConfigKey(key);
  if (!def) return "";
  return rawFromValue(def.get(config), def.valueType);
}

/** Возвращает ключу прежнее значение (откат записи). */
function restoreConfigValue(config: AppConfig, key: string, raw: string): void {
  if (!raw) return;
  setConfigValue(config, key, raw);
}

/** `POST /api/config {key, value}` — валидация, применение, персист, reconfigure. */
export function handleConfigPost(
  req: IncomingMessage,
  res: ServerResponse,
  s: ConfigStore & RuntimeState & HttpTransport & SseTransport & WorkspaceStore,
): void {
  if (!s.config) {
    sendJson(res, 503, { error: "config_unavailable" });
    return;
  }
  const config = s.config;
  readJsonBody(req, s.maxBodyBytes)
    .then(async (rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      const key = typeof rec.key === "string" ? rec.key : "";
      const rawValue = toRawValue(rec.value);
      if (!key || rawValue === null) {
        sendJson(res, 400, { ok: false, error: "invalid-value" });
        return;
      }
      // Во время хода reconfigure рискует живым раннером (resize/подмена
      // провайдера) — отклоняем запись до `turn_end`. Чтение (`GET /api/config`)
      // не затронуто; тема — исключение (см. `BUSY_EXEMPT_KEYS`).
      if (s.busy && !BUSY_EXEMPT_KEYS.has(key)) {
        sendJson(res, 409, { ok: false, error: "busy" });
        return;
      }

      // Предыдущее значение — для отката, если ход начнётся, пока мы ждём.
      // Свитч провайдера меняет и `model` (память INV-19 + INV-P1), поэтому
      // откат обязан вернуть обе части, иначе 409 оставит пустую модель.
      const previousRaw = previousConfigRaw(config, key);
      const previousModel = config.model;

      const result = setConfigValue(config, key, rawValue);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.reason });
        return;
      }
      // У `locale` в реестре `reconfigure: false`, так что больше некому применить
      // его к процесс-глобальному i18n. Делаем здесь, чтобы серверный вывод и
      // перезапрошенный словарь браузера сошлись сразу.
      if (key === "locale") setLocale(config.locale);

      // LSP-тумблеры живут в снапшоте `LspModule`, который `reconfigure` не
      // пересобирает: применяем их точечными сеттерами и сбрасываем кэш
      // диагностики, чтобы вкладка LSP перепробила серверы.
      if (key === "lsp.enabled") {
        s.lspSetEnabled?.(config.lsp?.enabled ?? true);
        s.lspDoctor = undefined;
      } else if (key === "lsp.offline") {
        s.lspSetOffline?.(config.lsp?.offline ?? false);
        s.lspDoctor = undefined;
      }

      // Окно контекста в режиме auto принадлежит провайдеру. При свитче модели/
      // провайдера его перепробует сам reconfigure (`reprobeActiveProvider`) —
      // один сетевой вызов на операцию (INV-W6). Здесь — только явное
      // включение auto, где UI ждёт `probed`, чтобы честно сказать «провайдер
      // не сообщил окно». Fail-open: молчащий бэкенд оставляет окно прежним.
      const autoContextSwitch = key === "model" || key === "provider.active";
      // Свитч модели/провайдера НЕ пробует окно здесь: reconfigure сделает это
      // сам (`reprobeActiveProvider`), иначе провайдер опрашивался бы дважды за
      // один свитч. Здесь проба нужна только для явного включения auto — там
      // UI ждёт результат, чтобы честно показать «провайдер не сообщил окно».
      const wantsAutoProbe =
        config.model.trim().length > 0 && key === "contextAuto" && result.value === true;
      let autoProbe: AutoContextResult | undefined;
      if (wantsAutoProbe) {
        autoProbe = await applyAutoContext(config);
        // TOCTOU: пока мы ждали проб, мог начаться ход. Reconfigure живого
        // раннера опасен — откатываем значение и отвечаем 409 (аудит §7.9).
        if (s.busy) {
          restoreConfigValue(config, key, previousRaw);
          sendJson(res, 409, { ok: false, error: "busy" });
          return;
        }
      }

      // Сначала персист, затем reconfigure — но только когда реестр требует
      // реконфига для ключа; иначе shared шаг зря дёргал бы провайдеров/модели
      // на каждое нажатие.
      // `model` живёт в домене agent, `provider.active` — в provider: без
      // отдельной записи очистка модели при свитче не переживёт рестарт.
      const modelChanged = key === "provider.active" && config.model !== previousModel;
      let persisted = true;
      let warning: string | undefined;
      if (modelChanged) {
        try {
          s.saveConfig?.(config, "model");
        } catch {
          persisted = false;
          warning = "config not persisted";
        }
      }
      if (needsRebuild(result.effects)) {
        const next = await persistAndReconfigure(s, config, key);
        persisted = persisted && next.persisted;
        warning = warning ?? next.warning;
      } else {
        try {
          s.saveConfig?.(config, key);
        } catch {
          persisted = false;
          warning = "config not persisted";
        }
      }
      const body: Record<string, unknown> = {
        ok: true,
        value: result.value,
        display: result.display,
        persisted,
      };
      if (warning) body.warning = warning;
      // Смена модели/провайдера: reconfigure уже перепробовал capabilities.
      // Отдаём их в ответе, чтобы чип не держал набор прошлой модели до
      // прихода SSE `models` (старые иконки при новом бэкенде — ложь).
      if (key === "model" || key === "provider.active") {
        const capabilities = capabilitiesBody(s.providerReasoning?.());
        if (capabilities) body.capabilities = capabilities;
      }
      // Итог пробы — чтобы UI честно сказал «провайдер не сообщил окно»,
      // когда auto включён, но бэкенд промолчал (fail-open).
      if (autoProbe) {
        body.contextWindow = autoProbe.contextWindow;
        body.probed = autoProbe.probed;
      } else if (autoContextSwitch && config.contextAuto !== false) {
        // Окно свитча измерил reconfigure — отдаём итог, но без `probed`:
        // HTTP-пробы в этом хендлере не было, врать про «провайдер сообщил»
        // нельзя.
        body.contextWindow = config.contextWindow;
      }
      // Все вкладки/окна держат собственную копию конфига; после записи шлём
      // событие, чтобы клиенты перечитали `/api/config` и настроечные панели
      // не показывали устаревшее значение (тот же контракт, что у plugins/MCP).
      broadcast({ type: "config", ts: Date.now() }, s);
      sendJson(res, 200, body);
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}

/** `GET /api/models[?provider=<name>]` — id моделей провайдера (по умолчанию активного). */
export function handleModelsGet(
  req: IncomingMessage,
  res: ServerResponse,
  s: ConfigStore & RuntimeState & HttpTransport & SseTransport,
): void {
  if (!s.knownModels) {
    sendJson(res, 503, { error: "models_unavailable" });
    return;
  }
  // `?provider=` — модели конкретной записи (страница экспертов): первый
  // запрос к незакешированной записи отвечает `loading: true`.
  let provider: string | null = null;
  try {
    provider = new URL(req.url ?? "/", "http://localhost").searchParams.get("provider");
  } catch {
    /* битый URL — активный провайдер */
  }
  if (provider && s.knownModelsFor) {
    const resolved = s.knownModelsFor(provider);
    sendJson(res, 200, { models: resolved.models, loading: resolved.loading, provider });
    return;
  }
  // `reasoning` аддитивен и выводится на запрос из живого конфига, так что ряд
  // селекторов всегда отражает активных провайдера+модель без reconfigure-обвязки.
  // Без wired конфига опускается (легаси-стабы).
  const activeState = s.knownModelsState?.();
  // «Повторить» после ошибки: GET сам запускает новую попытку (иначе кнопка
  // возвращала бы тот же error из кеша) и отвечает `loading`, чтобы клиент
  // продолжил опрос.
  const retrying =
    activeState?.error === true && !activeState.loading && !!s.knownModelsRefresh;
  if (retrying) void s.knownModelsRefresh!();
  const body: Record<string, unknown> = {
    models: activeState?.models ?? s.knownModels(),
  };
  if (activeState) {
    // Честные состояния: «грузится» и «не ответил» не маскируются под пустой
    // список (UI иначе говорит «провайдер не сообщил моделей» во всех случаях).
    body.loading = retrying ? true : activeState.loading;
    body.error = retrying ? false : activeState.error === true;
  }
  if (s.config) {
    const probe = s.providerReasoning?.();
    // Холодная llama-swap-модель не отдала /props на старте — стратегия осталась
    // из пресета. Читающий запрос даёт бэкенду ещё один шанс; успех публикует
    // SSE `models`, и клиент перечитает снимок (INV-R2/R7).
    if (probe?.needsReprobe === true && s.refreshProviderCapabilities) {
      void s.refreshProviderCapabilities();
    }
    body.reasoning = buildReasoningView(s.config, {
      reachable: s.providerReachable?.(),
      strategy: probe?.strategy as never,
      levels: probe?.levels,
      reasoningOff: probe?.reasoningOff,
    });
    // Capabilities активной модели для чипа композера. Отдельного запроса нет:
    // композер и так перечитывает список моделей после смены пары.
    const capabilities = capabilitiesBody(probe);
    if (capabilities) body.capabilities = capabilities;
  }
  sendJson(res, 200, body);
}
