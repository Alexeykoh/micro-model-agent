// Подстраница настроек одного плагина: визуализация своего файла настроек.
// Рендерится в поддиалоге (`openSubDialog`, как MCP-форма): манифест из
// `GET .../settings` → строки через общий `controlFor`, правка — `PUT`
// по одному ключу (как остальные секции, без кнопки Save).
import { el, icon } from "../dom.js";
import { api } from "../api.js";
import { t } from "../i18n.js";
import { setIndicator } from "../dialog.js";
import type { Dict } from "../core/store/types.js";
import { controlFor } from "./controls.js";
import { row } from "./panels-shared.js";

interface SettingDef {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "list" | "json";
  title?: string;
  description?: string;
  enum?: string[];
  min?: number;
  max?: number;
  secret?: boolean;
  placeholder?: string;
}

/** Манифест → псевдо-деф реестра для `controlFor` (тот же контракт, что секции). */
function asControlDef(def: SettingDef): Dict {
  const out: Dict = { key: def.key, title: def.title || def.key };
  switch (def.type) {
    case "boolean":
      out.valueType = "bool";
      break;
    case "number":
      out.valueType = "int";
      if (def.min !== undefined) out.min = def.min;
      if (def.max !== undefined) out.max = def.max;
      break;
    case "enum":
      out.valueType = "enum";
      out.enum = def.enum || [];
      break;
    case "list":
      out.valueType = "list";
      break;
    case "json":
      out.valueType = "json";
      break;
    default:
      out.valueType = "string";
  }
  return out;
}

/** Один ключ → сервер. JSON-строку парсим здесь, остальное приводит бэкенд. */
async function postOne(name: string, def: SettingDef, raw: unknown): Promise<boolean> {
  let value = raw;
  if (def.type === "json" && typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      setIndicator(t("web.settings.plugin_settings_invalid"), true);
      return false;
    }
  }
  const res = await api<Dict>("/api/plugins/" + encodeURIComponent(name) + "/settings", {
    method: "PUT",
    body: { values: { [def.key]: value } },
  });
  if (res.ok && res.data && res.data.ok) {
    setIndicator(t("web.settings.plugin_settings_saved"), false);
    return true;
  }
  const err = res.data && typeof res.data.error === "string" ? String(res.data.error) : "";
  setIndicator(err || t("web.settings.save_failed"), true);
  return false;
}

/** Секреты — тот же контрол, но парольный (значение и так redacted в `""`). */
function cloakSecrets(control: HTMLElement, def: SettingDef): void {
  if (def.secret !== true) return;
  const input = control.querySelector("input, textarea");
  if (input instanceof HTMLInputElement && input.type !== "checkbox") {
    input.type = "password";
    input.autocomplete = "new-password";
  }
  if (input instanceof HTMLElement) input.setAttribute("placeholder", "stored — blank keeps");
}

/** Форма подстраницы: по строке на ключ манифеста. */
export function pluginSettingsForm(name: string, data: Dict): HTMLElement {
  const box = el("div", "pform");
  const defs = (Array.isArray(data.schema) ? data.schema : []) as SettingDef[];
  const values = (data.values && typeof data.values === "object" ? data.values : {}) as Dict;
  if (!defs.length) {
    box.appendChild(el("div", "placeholder", t("web.settings.plugin_settings_empty")));
    return box;
  }
  for (const def of defs) {
    const control = controlFor(asControlDef(def), values[def.key], {
      label: def.title || def.key,
      enumLabel: (v: string) => v,
      emptyLabel: "—",
      post: (raw: unknown) => void postOne(name, def, raw),
    });
    cloakSecrets(control, def);
    const label = def.title || def.key;
    const desc = typeof def.description === "string" ? def.description : "";
    box.appendChild(row(label, control, desc));
  }
  return box;
}

/** Иконка-кнопка «настройки» для строки плагина (тихая, как остальные chips). */
export function settingsChip(name: string, onOpen: (name: string) => void): HTMLElement {
  const b = el("button", "chip icon-btn", "");
  b.type = "button";
  b.appendChild(icon("settings"));
  const label = t("web.settings.plugin_settings_open");
  b.title = label;
  b.setAttribute("aria-label", label + ": " + name);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onOpen(name);
  });
  return b;
}
