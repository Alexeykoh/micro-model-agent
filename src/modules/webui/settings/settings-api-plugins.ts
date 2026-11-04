/**
 * REST-хендлеры настроек Skills и Plugins (включая живой тумблер).
 * Вынесено из `settings-api.ts` (правило 6).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestError, sendJson } from "../util";
import { readJsonBody } from "../http/body";
import { broadcast } from "../state";
import { setConfigValue } from "../../../config/registry";
import { mcpList } from "./settings-api-mcp";
import type { SettingsState } from "./settings-api-write";

/** `GET /api/skills` — доступные скиллы с флагом загруженности. */
export function handleSkillsGet(res: ServerResponse, s: SettingsState): void {
  if (!s.skills) {
    sendJson(res, 503, { error: "skills_unavailable" });
    return;
  }
  const loaded = new Set(s.skills.getLoaded().map((skill) => skill.name));
  const skills = s.skills.getAvailable().map((skill) => {
    const info: Record<string, unknown> = { name: skill.name, enabled: loaded.has(skill.name) };
    if (skill.description) info.description = skill.description;
    if (skill.sourcePath) info.source = skill.sourcePath;
    return info;
  });
  sendJson(res, 200, { skills });
}

/**
 * `GET /api/plugins` — плагины (полные записи) + отказы загрузки + MCP-серверы.
 *
 * Ответ аддитивно расширен: `plugins` теперь `PluginRecord[]` вместо узкого
 * вида с захардкоженным `enabled: true`, плюс `failures` — сломанный плагин
 * раньше просто исчезал из всех списков.
 */
export function handlePluginsGet(res: ServerResponse, s: SettingsState): void {
  if (!s.plugins) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return;
  }
  sendJson(res, 200, {
    plugins: s.plugins.getRecords(),
    failures: s.plugins.getFailures(),
    mcp: mcpList(s),
  });
}

/**
 * `POST /api/plugins/reload` — перечитать каталоги плагинов и навыков с диска.
 *
 * Живая перезагрузка без пересборки агента: выгрузка с `onUnload` → сброс
 * кэса модулей → чтение заново. Ответ несёт `reload.staleTs` — сколько `.ts`
 * плагинов под Node сохранили старый код (кэш transpile не сбрасывается),
 * чтобы UI не врёл об успехе.
 */
export function handlePluginsReload(res: ServerResponse, s: PluginToggleStore): void {
  const plugins = s.plugins;
  if (!plugins) {
    sendJson(res, 503, { error: "plugins_unavailable" });
    return;
  }
  try {
    const report = plugins.reload();
    const skills = s.skills?.reloadSources?.();
    sendJson(res, 200, {
      ok: true,
      plugins: plugins.getRecords(),
      failures: plugins.getFailures(),
      reload: { plugins: report, skills: skills ?? { added: 0, removed: 0 } },
    });
    broadcast({ type: "plugins", ts: Date.now() }, s);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e) });
  }
}

/**
 * `POST /api/plugins/:name {enabled}` — живой тумблер плагина (без рестарта).
 *
 * Пишет ТОЛЬКО через `setConfigValue("plugins.disabled", …)`: эффект
 * (`PluginManager.setDisabledAll`) применяется внутри `setConfigValue` через
 * шов в `config/registry`, поэтому этот путь и `/config plugins.disabled`, и
 * `mma plugins disable` не могут разойтись.
 */
type PluginToggleStore = SettingsState;

/** Ошибка запроса тумблера: код + машиночитаемое имя (null — всё в порядке). */
type ToggleError = { status: number; error: string } | null;

/** Валидация тела `POST /api/plugins/:name`. */
function pluginToggleError(
  plugins: NonNullable<PluginToggleStore["plugins"]>,
  name: string,
  enabled: unknown,
): ToggleError {
  if (typeof enabled !== "boolean") return { status: 400, error: "invalid-enabled" };
  const record = plugins.getRecords().find((p) => p.name === name);
  if (!record) return { status: 404, error: "not_found" };
  if (record.system && enabled === false) return { status: 409, error: "system" };
  return null;
}

/** Запись deny-list через единый путь + персист; null — запись отвергнута. */
function persistPluginDenyList(
  config: NonNullable<PluginToggleStore["config"]>,
  save: PluginToggleStore["saveConfig"],
  name: string,
  enable: boolean,
): ToggleError | { persisted: boolean } {
  const denied = new Set(config.plugins?.disabled ?? []);
  if (enable) denied.delete(name);
  else denied.add(name);
  const result = setConfigValue(config, "plugins.disabled", [...denied].join(","));
  if (!result.ok) return { status: 400, error: "invalid-value" };
  let persisted = true;
  try {
    save?.(config);
  } catch {
    // Не записалось — сообщаем `persisted: false`, но запуск не роняем:
    // поведение уже применено к живому реестру.
    persisted = false;
  }
  return { persisted };
}

/** Тело тумблера: валидация → запись через `setConfigValue` → ответ. */
function applyPluginToggle(
  res: ServerResponse,
  name: string,
  enabled: unknown,
  s: PluginToggleStore,
): void {
  const plugins = s.plugins;
  const config = s.config;
  if (!plugins || !config) return; // 503 уже отправлен вызывающим
  const enable = enabled === true;
  const bad = pluginToggleError(plugins, name, enabled);
  const written = bad ? bad : persistPluginDenyList(config, s.saveConfig, name, enable);
  if (bad) {
    sendJson(res, bad.status, { ok: false, error: bad.error });
    return;
  }
  if (!written || "status" in written) {
    sendJson(res, 400, { ok: false, error: "invalid-value" });
    return;
  }
  // Шов `setConfigValue → pluginGateApplier` может не быть установлен: повторяем
  // toggle напрямую, чтобы ответ отражал фактическое состояние.
  plugins.setEnabled(name, enable);
  sendJson(res, 200, {
    ok: true,
    persisted: written.persisted,
    plugins: plugins.getRecords(),
    failures: plugins.getFailures(),
  });
  broadcast({ type: "plugins", ts: Date.now() }, s);
}

export function handlePluginToggle(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  s: PluginToggleStore,
): void {
  if (!s.plugins || !s.config) {
    sendJson(res, 503, { error: s.plugins ? "config_unavailable" : "plugins_unavailable" });
    return;
  }
  readJsonBody(req, s.maxBodyBytes)
    .then((rec) => {
      if (!rec) {
        sendJson(res, 400, { ok: false, error: "invalid JSON" });
        return;
      }
      applyPluginToggle(res, name, rec.enabled, s);
    })
    .catch((err: unknown) => {
      requestError(req, res, err);
    });
}
