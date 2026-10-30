// REST-хендлеры поверхностей конфига/модели `mma web` (вынесены из server.ts).
// Отсутствующий коллаборатор — пробел wiring, такие точки отвечают 503, не крашатся.
// Auth и same-origin проверяются выше в `server.ts`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { setLocale } from "../../../i18n/index";
import { serializeConfigForWire } from "../../../config/redact";
import { configDefs, resolveConfigKey, setConfigValue, type ConfigKeyDef } from "../../../config/registry";
import { configVersion } from "../../../config/persist";
import { needsRebuild } from "../../../config/effects";
import type { AppConfig } from "../../../config/types";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { persistAndReconfigure } from "../http/persist";
import { applyAutoContext, type AutoContextResult } from "./context-auto";
import { rawFromValue } from "../../../cli/config-mutations";
import { buildReasoningView } from "./reasoning-view";
import type { ConfigStore, RuntimeState, HttpTransport, SseTransport, WorkspaceStore } from "../state";
import { broadcast } from "../state";

/**
 * Ключи, которые можно писать во время хода. У них `effects: []` — reconfigure
 * живого раннера не запускается, риска из аудита §7.9 нет. Сейчас это тема
 * веб-UI: пользователь переключает оформление и во время ответа модели, и
 * терять выбор (409) из-за этого нельзя (INV-T3 спеки
 * `2026-10-30-webui-theme-persistence-design.md`).
 */
const BUSY_EXEMPT_KEYS: ReadonlySet<string> = new Set(["ui.theme", "ui.themeMode"]);

/** Запись реестра для UI настроек. */
export interface ConfigRegistryEntry {
  key: string;
  aliases: string[];
  valueType: string;
  group: string;
  enum?: readonly string[];
  /**
   * Численные границы для контролов `int`/`share`. Из дефов реестра, где есть
   * реальная мета (напр. доли — те же лимиты 0.05–0.9, что держит парсер,
   * `contextWindow` мин 1024); у безлимитных опускаются.
   */
  min?: number;
  max?: number;
  step?: number;
  /** `version` и подобные в UI рендерятся нередактируемым значением. */
  readOnly?: boolean;
  /**
   * Резолвленное значение read-only ключей. Их геттер реестра авторитетен и
   * может отличаться от сырого поля конфига (напр. `version` отдаёт версию
   * установленного пакета, а не версию схемы конфига).
   */
  value?: unknown;
  /** Подсказка GUI-рендера значений `list`/`json` (чипсы, чекбоксы, таблица). */
  editor?: ConfigKeyDef["editor"];
}

/** Сериализует реестр в порядке реестра (только канонические ключи). */
export function buildConfigRegistry(config?: AppConfig): ConfigRegistryEntry[] {
  return configDefs().map((def) => {
    const entry: ConfigRegistryEntry = {
      key: def.key,
      aliases: def.aliases,
      valueType: def.valueType,
      group: def.domain,
    };
    if (def.enumValues) entry.enum = def.enumValues;
    if (def.min !== undefined) entry.min = def.min;
    if (def.max !== undefined) entry.max = def.max;
    if (def.step !== undefined) entry.step = def.step;
    if (def.readOnly) {
      entry.readOnly = true;
      if (config) entry.value = def.get(config);
    }
    if (def.editor) entry.editor = def.editor;
    return entry;
  });
}

/** Маскирует секрет для показа: последние 4 символа видны, остальное скрыто. */
function maskToken(token: string | null): string | null {
  if (!token) return null;
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

/** `GET /api/config` — отредактированный живой конфиг + реестр ключей. */
export function handleConfigGet(res: ServerResponse, s: ConfigStore & RuntimeState & HttpTransport & SseTransport): void {
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
      const previousRaw = previousConfigRaw(config, key);

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

      // Включение auto у контекста спрашивает провайдера ДО персиста/reconfigure:
      // иначе юзер увидел бы «auto» со старым числом, а бюджеты пересчитались бы
      // только на ближайшем старте. Fail-open — при молчащем бэкенде окно прежнее.
      let autoProbe: AutoContextResult | undefined;
      if (key === "contextAuto" && result.value === true) {
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
      let persisted = true;
      let warning: string | undefined;
      if (needsRebuild(result.effects)) {
        ({ persisted, warning } = await persistAndReconfigure(s, config, key));
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
      // Итог пробы — чтобы UI честно сказал «провайдер не сообщил окно»,
      // когда auto включён, но бэкенд промолчал (fail-open).
      if (autoProbe) {
        body.contextWindow = autoProbe.contextWindow;
        body.probed = autoProbe.probed;
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

/** `GET /api/models` — id моделей активного провайдера. */
export function handleModelsGet(res: ServerResponse, s: ConfigStore & RuntimeState & HttpTransport & SseTransport): void {
  if (!s.knownModels) {
    sendJson(res, 503, { error: "models_unavailable" });
    return;
  }
  // `reasoning` аддитивен и выводится на запрос из живого конфига, так что ряд
  // селекторов всегда отражает активных провайдера+модель без reconfigure-обвязки.
  // Без wired конфига опускается (легаси-стабы).
  const body: Record<string, unknown> = { models: s.knownModels() };
  if (s.config) body.reasoning = buildReasoningView(s.config);
  sendJson(res, 200, body);
}
