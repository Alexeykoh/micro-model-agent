// Generic settings controls for the `mma web` settings modal (`settings.js`).
// One renderer per registry `valueType`; rows, labels and descriptions stay in
// `settings.js` (same `row`/`el` styling). Never uses innerHTML — all user or
// config data goes through `textContent` (XSS rule).
import { el, makeToggle } from "./dom.js";

// Validate raw JSON text without posting. Empty input is invalid (the backend
// would reject it too); the caller shows `error` inline and skips the POST.
export function validateJson(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return { ok: false, error: "required" };
  try {
    JSON.parse(raw);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

function textInput(label, value) {
  const input = el("input");
  input.setAttribute("aria-label", label);
  input.value = value;
  return input;
}

// `def`: registry entry ({valueType, enum, min, max, step, readOnly}).
// `value`: current config value at the key (`getPath` result).
// `ctx`: { label, enumLabel(v), post(rawValue) } — `post` is `settings.js`
// `postConfig`, injected so this module never touches the API directly.
export function controlFor(def, value, ctx) {
  if (def.readOnly) {
    const ro = el("span", "val dim", value == null ? "—" : String(value));
    if (value != null) ro.title = String(value);
    return ro;
  }
  if (def.valueType === "bool") {
    return makeToggle(!!value, (next) => {
      ctx.post(next);
      return true;
    });
  }
  if (def.valueType === "enum") {
    const sel = el("select");
    sel.setAttribute("aria-label", ctx.label);
    (def.enum || []).forEach((v) => {
      const o = el("option", "", ctx.enumLabel(v));
      o.value = v;
      if (v === value) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => ctx.post(sel.value));
    return sel;
  }
  if (def.valueType === "int") {
    const input = textInput(ctx.label, value == null ? "" : String(value));
    input.type = "number";
    if (def.min != null) input.min = String(def.min);
    if (def.max != null) input.max = String(def.max);
    if (def.step != null) input.step = String(def.step);
    input.addEventListener("change", () => ctx.post(input.value));
    return input;
  }
  if (def.valueType === "share") {
    const input = textInput(ctx.label, value == null ? "" : Math.round(Number(value) * 100) + "%");
    input.addEventListener("change", () => ctx.post(input.value));
    return input;
  }
  if (def.valueType === "list") {
    const shown = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value);
    const input = textInput(ctx.label, shown);
    input.placeholder = "a, b, c";
    // The backend splits the raw comma string — post it verbatim.
    input.addEventListener("change", () => ctx.post(input.value));
    return input;
  }
  if (def.valueType === "json") {
    const wrap = el("div", "jsonctl");
    const area = el("textarea");
    area.setAttribute("aria-label", ctx.label);
    area.rows = 3;
    area.value = value == null ? "" : JSON.stringify(value, null, 2);
    const err = el("div", "json-err");
    err.hidden = true;
    area.addEventListener("input", () => {
      const r = validateJson(area.value);
      err.hidden = r.ok;
      err.textContent = r.ok ? "" : String(r.error || "invalid JSON");
    });
    // Post only when valid — an invalid draft stays editable, no error toast.
    area.addEventListener("change", () => {
      if (validateJson(area.value).ok) ctx.post(area.value.trim());
      else area.focus();
    });
    wrap.appendChild(area);
    wrap.appendChild(err);
    return wrap;
  }
  const input = textInput(ctx.label, value == null ? "" : String(value));
  input.addEventListener("change", () => ctx.post(input.value));
  return input;
}

// Additive keys for the top-level panels (merged into `SECTION_KEYS` in
// `settings.js`). Everything else deep lives in `ADVANCED_GROUPS` below.
export const EXTRA_SECTIONS = {
  general: ["provider.fallback", "autoPlan"],
};

// Nested groups inside the Advanced panel ("Дополнительно"): progressive
// disclosure for in-depth settings. Order is the render order; `titleKey` is
// `web.settings.advg.<id>`. Consumed by `renderAdvancedPanel` (settings.js).
export const ADVANCED_GROUPS = [
  { id: "model", titleKey: "web.settings.advg.model", keys: ["provider.maxCompletionTokens", "modelLoad.autoLoad", "modelLoad.flashAttention", "modelLoad.offloadKvCacheToGpu", "modelLoad.evalBatchSize"] },
  { id: "context", titleKey: "web.settings.advg.context", keys: ["contextBudget.compactionThreshold", "contextBudget.compactionMinLoad", "instructions.summarize", "contextLog.enabled", "contextLog.redact"] },
  { id: "reasoning", titleKey: "web.settings.advg.reasoning", keys: ["reasoning.min", "reasoning.max", "reasoning.baseline", "reasoning.overrideCooldown"] },
  { id: "agent", titleKey: "web.settings.advg.agent", keys: ["tools.enableOnDemand", "skills.budget", "hallucination.judge.enabled", "subagent.resultMode", "subagent.maxSummaryChars", "subagent.maxParallelChunkQueries", "subagent.stableSystemPrompt"] },
  { id: "network", titleKey: "web.settings.advg.network", keys: ["webSearch.enabled", "errorWebSearch.enabled", "errorWebSearch.threshold", "errorWebSearch.maxResults", "errorWebSearch.maxQueryChars", "errorWebSearch.maxSearchesPerSession", "errorWebSearch.requestTimeoutMs"] },
  { id: "browser", titleKey: "web.settings.advg.browser", keys: ["browser.enabled", "browser.headless", "browser.maxElements", "browser.maxContentChars", "browser.maxConsoleEntries", "browser.maxConsoleLineChars", "browser.viewportWidth", "browser.viewportHeight", "browser.navigationTimeout"] },
  { id: "sessions", titleKey: "web.settings.advg.sessions", keys: ["session.autoSave", "session.maxSessions", "session.isolateMemory", "session.autoName", "sessionIsolation.enabled", "sessionIsolation.isolatePlugins", "sessionIsolation.isolateTempFiles"] },
  { id: "service", titleKey: "web.settings.advg.service", keys: ["pricing.enabled", "updater.enabled", "updater.checkOnStart", "updater.autoInstall", "updater.intervalMs"] },
  { id: "retry", titleKey: "web.settings.advg.retry", keys: ["retry.maxRetries", "retry.baseDelay", "retry.maxDelay", "retry.maxStreamRetries", "retry.noDataTimeoutMs"] },
  { id: "lists", titleKey: "web.settings.advg.lists", keys: ["tools.defaultTags", "security.bash.blacklist", "security.bash.whitelist", "security.bash.dangerousFlags", "security.bash.dangerousOperators", "security.paths.denied", "security.paths.allowed", "security.network.deniedDomains", "security.network.allowedDomains", "security.contentScan.dangerousPatterns", "security.auditNotifier.eventTypes"] },
  { id: "security", titleKey: "web.settings.advg.security", keys: ["security.maxRecursionDepth", "security.maxFileOperations", "security.rateLimits.maxRequestsPerMinute", "security.rateLimits.maxParallelTasks", "security.network.requestTimeout", "security.network.maxResponseSize", "security.auditNotifier.enabled", "security.auditNotifier.filePath", "security.auditNotifier.webhookUrl", "security.auditNotifier.webhookTimeout", "security.auditNotifier.minSeverity", "security.auditNotifier.maxRetries", "security.sessionEncryption.keyPath", "security.sessionEncryption.encryptHistory", "security.sessionEncryption.encryptSessionLog"] },
  { id: "json", titleKey: "web.settings.advg.json", keys: ["pricing.overrides", "modelCapabilities", "experts"] },
];
