// Provider add/edit form field builders.
// Extracted from `settings/providers.js`: preset row, base-URL dropdown and
// advanced tuning fields. Shared form primitives come from `settings/form.js`.
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { pfield, providerInput, providerSelect, providerCheck } from "./form.js";

export interface BaseField {
  node: HTMLElement;
  sel: HTMLSelectElement;
  custom: HTMLInputElement;
  value: string;
  addEventListener(ev: string, fn: EventListenerOrEventListenerObject): void;
  setAttribute(k: string, v: string): void;
}

// Base-URL field: a dropdown of well-known URLs plus a "custom URL" option
// revealing a free-text input, so corporate proxies stay enterable.
// Exposes a `.value` get/set compatible with plain inputs, plus the raw
// `sel`/`custom` nodes for event wiring.
export function providerBaseField(value: unknown): BaseField {
  const node = el("div", "pform-base");
  const sel = el("select");
  PROVIDER_BASE_URLS.forEach(([label, url]) => {
    const o = el("option", "", label + " — " + url);
    o.value = url;
    sel.appendChild(o);
  });
  const customOpt = el("option", "", t("web.settings.provider_baseurl_custom"));
  customOpt.value = BASE_URL_CUSTOM;
  sel.appendChild(customOpt);
  const custom = providerInput("", "text", "https://…");
  const known = new Set(PROVIDER_BASE_URLS.map(([, url]) => url));
  const sync = () => {
    custom.style.display = sel.value === BASE_URL_CUSTOM ? "" : "none";
  };
  const field: BaseField = {
    node,
    sel,
    custom,
    get value() {
      return sel.value === BASE_URL_CUSTOM ? custom.value : sel.value;
    },
    set value(v: string) {
      if (v && known.has(v)) {
        sel.value = v;
      } else {
        sel.value = BASE_URL_CUSTOM;
        custom.value = v || "";
      }
      sync();
    },
    addEventListener(ev, fn) {
      sel.addEventListener(ev, fn);
      custom.addEventListener(ev, fn);
    },
    setAttribute(k, v) {
      sel.setAttribute(k, v);
    },
  };
  field.value = value ? String(value) : "";
  sel.addEventListener("change", sync);
  node.appendChild(sel);
  node.appendChild(custom);
  return field;
}

const CACHE_FLAG_KEYS = [
  "sessionHeader",
  "requestCachePrompt",
  "requestPromptCacheKey",
  "requestSessionId",
  "requestCacheControl",
  "requestStreamUsage",
];

// Known provider types (mirrors BUILTIN_PROVIDERS in src/modules/providers/presets.ts)
// and well-known local base URLs. Both render as real `<select>` dropdowns —
// `datalist` hints were replaced because they don't read as a list and behave
// inconsistently across browsers.
export const PROVIDER_TYPES = [
  "openai-compat",
  "lmstudio",
  "openrouter",
  "openai",
  "anthropic",
  "opencode-zen",
  "opencode-go",
];

const PROVIDER_BASE_URLS: Array<[string, string]> = [
  ["LM Studio", "http://localhost:1234/v1"],
  ["Ollama", "http://localhost:11434/v1"],
  ["OpenRouter", "https://openrouter.ai/api/v1"],
  ["OpenAI", "https://api.openai.com/v1"],
  ["Anthropic", "https://api.anthropic.com"],
];

const BASE_URL_CUSTOM = "__custom__";

export interface PresetField {
  presets: Dict[];
  sel: HTMLSelectElement | null;
  node: HTMLElement | null;
}

// One-click preset row: selecting a builtin fills type/label/base URL, so
// hosted providers need no URL knowledge. `custom` leaves the fields free.
// Returns the row node (null when no presets) plus the raw select for wiring.
export function providerPresetField(editing: Dict): PresetField {
  const presets = settings.providerPresets || [];
  if (!presets.length) return { presets, sel: null, node: null };
  const sel = el("select", "pform-preset");
  const custom = el("option", "", t("web.settings.provider_custom"));
  custom.value = "";
  sel.appendChild(custom);
  presets.forEach((p: Dict) => {
    const o = el("option", "", p.label || p.type);
    o.value = p.id;
    sel.appendChild(o);
  });
  const match =
    presets.find((p: Dict) => p.type === editing.type && p.baseUrl && p.baseUrl === editing.baseUrl) ||
    presets.find((p: Dict) => p.type === editing.type && !p.baseUrl) ||
    presets.find((p: Dict) => p.type === editing.type);
  if (match) sel.value = match.id;
  return { presets, sel, node: pfield("web.settings.provider_preset", sel) };
}

// Keep the preset select and the type field in sync both ways.
export function wirePresetSync(
  presets: Dict[],
  presetSel: HTMLSelectElement | null,
  mode: string,
  f: { type: HTMLSelectElement; label: HTMLInputElement; base: BaseField },
): void {
  if (!presetSel) return;
  presetSel.addEventListener("change", () => {
    const p = presets.find((x) => x.id === presetSel.value);
    if (!p) return;
    f.type.value = p.type;
    if (mode === "add" || !f.label.value.trim()) f.label.value = p.name;
    f.base.value = p.baseUrl || "";
  });
  f.type.addEventListener("input", () => {
    const sel = presets.find((x) => x.id === presetSel.value);
    if (!sel || f.type.value.trim() !== sel.type) presetSel.value = "";
  });
  // The type control is a `<select>`: some browsers fire only `change`.
  f.type.addEventListener("change", () => {
    const sel = presets.find((x) => x.id === presetSel.value);
    if (!sel || f.type.value.trim() !== sel.type) presetSel.value = "";
  });
}

export interface CacheFlag {
  key: string;
  box: HTMLInputElement;
  node: HTMLElement;
}

// Optional tuning fields stay collapsed so the form reads as "type + URL".
export function providerAdvancedFields(editing: Dict) {
  const adv = el("details", "pform-adv");
  adv.appendChild(el("summary", "", t("web.settings.provider_advanced")));
  const advGrid = el("div", "pform-grid");
  const cache = editing.cache || {};
  const retry = editing.retry || {};
  const f = {
    ctx: providerInput(editing.contextWindow, "number", "32768"),
    prio: providerInput(editing.priority, "number", "0"),
    rpm: providerInput(editing.rpm, "number", "60"),
    par: providerInput(editing.parallel, "number", "1"),
    maxTokens: providerInput(editing.maxCompletionTokens, "number", "8192"),
    cacheMech: providerSelect(["auto", "explicit", "local", "none"], cache.mechanism),
    cacheReport: providerSelect(["openai", "deepseek", "anthropic", "ollama", "none"], cache.report),
    retryMax: providerInput(retry.maxRetries, "number", "3"),
    retryBase: providerInput(retry.baseDelay, "number", "1000"),
    retryMaxD: providerInput(retry.maxDelay, "number", "30000"),
    cacheFlags: [] as CacheFlag[],
  };
  // Flags keep the raw config key in `title` so it stays searchable, but the
  // visible label is localized like every other field of the form.
  f.cacheFlags = CACHE_FLAG_KEYS.map((key) => {
    const box = providerCheck(cache[key]);
    const label = t("web.settings.provider_flag." + key);
    box.setAttribute("aria-label", label);
    const wrap = el("label", "pform-check");
    wrap.title = key;
    wrap.appendChild(box);
    wrap.appendChild(el("span", "", label));
    return { key, box, node: wrap };
  });
  advGrid.appendChild(pfield("web.settings.provider_context", f.ctx));
  advGrid.appendChild(pfield("web.settings.provider_priority", f.prio));
  advGrid.appendChild(pfield("web.settings.provider_rpm", f.rpm));
  advGrid.appendChild(pfield("web.settings.provider_parallel", f.par));
  advGrid.appendChild(pfield("web.settings.provider_max_tokens", f.maxTokens));
  advGrid.appendChild(pfield("web.settings.provider_cache_mechanism", f.cacheMech));
  advGrid.appendChild(pfield("web.settings.provider_cache_report", f.cacheReport));
  adv.appendChild(advGrid);

  // Retry numbers reuse the field grid (label above input) — a bare label+input
  // pair collapses into an unreadable inline blob without the grid styles.
  const retryGroup = el("div", "pform-checks");
  retryGroup.appendChild(el("span", "pform-checks-title", t("web.settings.provider_retry")));
  const retryGrid = el("div", "pform-grid");
  retryGrid.appendChild(pfield("web.settings.provider_retry_max", f.retryMax));
  retryGrid.appendChild(pfield("web.settings.provider_retry_base", f.retryBase));
  retryGrid.appendChild(pfield("web.settings.provider_retry_maxdelay", f.retryMaxD));
  retryGroup.appendChild(retryGrid);
  adv.appendChild(retryGroup);

  const flagGroup = el("div", "pform-checks");
  flagGroup.appendChild(el("span", "pform-checks-title", t("web.settings.provider_cache_flags")));
  const flagGrid = el("div", "pform-checks-grid");
  f.cacheFlags.forEach(({ node }) => flagGrid.appendChild(node));
  flagGroup.appendChild(flagGrid);
  adv.appendChild(flagGroup);
  return { node: adv, ...f };
}
