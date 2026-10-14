// Generic settings controls for the `mma web` settings modal (`settings.js`).
// One renderer per registry `valueType`; rows, labels and descriptions stay in
// `settings.js` (same `row`/`el` styling). Structured editors (`tags`/
// `checkboxes`/`table`) live in `./editors.js`. Never uses innerHTML — all user
// or config data goes through `textContent` (XSS rule).
import { el, makeToggle } from "../dom.js";
import type { Dict } from "../core/store/types.js";
import { tagsEditor, checkboxEditor, tableEditor } from "./editors.js";

export interface JsonValidation {
  ok: boolean;
  error?: string;
}

// Validate raw JSON text without posting. Empty input is invalid (the backend
// would reject it too); the caller shows `error` inline and skips the POST.
export function validateJson(text: unknown): JsonValidation {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return { ok: false, error: "required" };
  try {
    JSON.parse(raw);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "invalid JSON" };
  }
}

function textInput(label: string, value: string): HTMLInputElement {
  const input = el("input");
  input.setAttribute("aria-label", label);
  input.value = value;
  return input;
}

// Dropdown fed by a *live* source (`models`/`providers` from `/api`), not by a
// static `enumValues`. An empty selection posts `""` (unset → use active). A
// stored value missing from the list stays selectable. No options available
// (boot / 503) degrades to a plain text input so the user is never trapped.
function selectEditor(value: unknown, ctx: Dict, editor: Dict): HTMLElement {
  const source = editor.optionsSource;
  const opts: string[] = source === "providers" ? ctx.providerOptions || [] : ctx.modelOptions || [];
  const current = typeof value === "string" ? value : "";
  if (!opts.length) {
    const input = textInput(ctx.label, current);
    input.addEventListener("change", () => ctx.post(input.value));
    return input;
  }
  const sel = el("select");
  sel.setAttribute("aria-label", ctx.label);
  const none = el("option", "", ctx.emptyLabel || "—");
  none.value = "";
  sel.appendChild(none);
  const seen = new Set([""]);
  opts.forEach((v: string) => {
    if (seen.has(v)) return;
    seen.add(v);
    const o = el("option", "", v);
    o.value = v;
    if (v === current) o.selected = true;
    sel.appendChild(o);
  });
  if (current && !seen.has(current)) {
    const o = el("option", "", current);
    o.value = current;
    o.selected = true;
    sel.appendChild(o);
  }
  // Set explicitly: some DOM implementations don't reflect per-option
  // `selected` set before the option is attached to the select.
  sel.value = current || "";
  sel.addEventListener("change", () => ctx.post(sel.value));
  return sel;
}

// `def`: registry entry ({valueType, enum, min, max, step, readOnly}).
// `value`: current config value at the key (`getPath` result).
// `ctx`: { label, enumLabel(v), post(rawValue) } — `post` is `settings.js`
// `postConfig`, injected so this module never touches the API directly.
export function controlFor(def: Dict, value: unknown, ctx: Dict): HTMLElement {
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
    (def.enum || []).forEach((v: string) => {
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
  const editor = def.editor;
  if (editor && editor.kind === "select") {
    return selectEditor(value, ctx, editor);
  }
  if (editor && editor.kind === "tags" && (def.valueType === "list" || def.valueType === "json")) {
    return tagsEditor(value, ctx, editor);
  }
  if (editor && editor.kind === "checkboxes") {
    return checkboxEditor(value, ctx, editor);
  }
  if (editor && editor.kind === "table") {
    return tableEditor(value, ctx, editor);
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

// Single source of truth for the settings information architecture.
//
// Every panel is a list of *named sections* — the title must describe exactly
// what is inside (research: settings fail when category names do not match the
// controls under them, and when an "Advanced" bucket collects unrelated keys).
// `search` (settings.js) indexes the same table, so a key can never be
// reachable but unfindable.
//
// Panel ids match `data-p` / `data-panel` in index.html. Panels with custom
// bodies (model, ui, memory, skills, plugins) render their own content first
// and then these sections.
export const PANEL_SECTIONS: Record<string, Dict[]> = {
  general: [
    { id: "general.interface", titleKey: "web.settings.sec.general.interface", keys: ["locale", "ui.verbosity"] },
    { id: "general.agent", titleKey: "web.settings.sec.general.agent", descKey: "web.settings.sec.general.agent.desc", keys: ["maxToolIterations", "stuckThreshold", "autoPlan", "execution.autoAdvance"] },
    { id: "general.provider", titleKey: "web.settings.sec.general.provider", keys: ["provider.fallback"] },
    { id: "general.update", titleKey: "web.settings.sec.general.update", descKey: "web.settings.sec.general.update.desc", keys: ["updater.enabled", "updater.autoInstall", "updater.intervalMs"] },
  ],
  model: [
    { id: "model.tuning", titleKey: "web.settings.sec.model.tuning", descKey: "web.settings.sec.model.tuning.desc", keys: ["provider.maxCompletionTokens", "modelLoad.autoLoad", "modelLoad.flashAttention", "modelLoad.evalBatchSize", "modelLoad.offloadKvCacheToGpu"] },
    { id: "model.capabilities", titleKey: "web.settings.sec.model.capabilities", descKey: "web.settings.sec.model.capabilities.desc", keys: ["modelCapabilities"] },
  ],
  context: [
    { id: "context.window", titleKey: "web.settings.sec.context.window", descKey: "web.settings.sec.context.window.desc", keys: ["contextWindow", "contextAuto", "contextBudget.systemPrompt", "contextBudget.responseReserve"] },
    { id: "context.compaction", titleKey: "web.settings.sec.context.compaction", descKey: "web.settings.sec.context.compaction.desc", keys: ["contextBudget.compactionThreshold", "contextBudget.compactionMinLoad", "contextBudget.policy", "contextBudget.compactionSummary", "contextBudget.overflowCooldown", "contextBudget.toolResultKeep", "contextBudget.admitMaxTokens", "contextBudget.notesPath", "contextBudget.ledgerMax", "contextBudget.calibrationWarmup", "contextBudget.ratioFloor"] },
    { id: "context.instructions", titleKey: "web.settings.sec.context.instructions", descKey: "web.settings.sec.context.instructions.desc", keys: ["instructions.summarize"] },
    { id: "context.indexer", titleKey: "web.settings.sec.context.indexer", descKey: "web.settings.sec.context.indexer.desc", keys: ["indexer.maxFiles", "indexer.respectGitignore", "indexer.mapTokenBudget"] },
    { id: "context.log", titleKey: "web.settings.sec.context.log", descKey: "web.settings.sec.context.log.desc", keys: ["contextLog.enabled", "contextLog.redact"] },
  ],
  reasoning: [
    { id: "reasoning.display", titleKey: "web.settings.sec.reasoning.display", keys: ["showReasoning"] },
    { id: "reasoning.effort", titleKey: "web.settings.sec.reasoning.effort", descKey: "web.settings.sec.reasoning.effort.desc", keys: ["reasoning.mode", "reasoning.min", "reasoning.max", "reasoning.baseline", "reasoning.overrideCooldown"] },
  ],
  agent: [
    { id: "agent.experts", titleKey: "web.settings.sec.agent.experts", descKey: "web.settings.sec.agent.experts.desc", keys: ["experts"] },
    { id: "agent.critic", titleKey: "web.settings.sec.agent.critic", descKey: "web.settings.sec.agent.critic.desc", keys: ["critic.enabled", "critic.model", "critic.provider", "critic.tools", "critic.maxCalls", "critic.maxRepairCycles", "critic.timeoutMs", "critic.maxTokens"] },
    { id: "agent.tools", titleKey: "web.settings.sec.agent.tools", descKey: "web.settings.sec.agent.tools.desc", keys: ["tools.enableOnDemand", "tools.defaultTags", "tools.grepEngine", "skills.budget"] },
    { id: "agent.subagent", titleKey: "web.settings.sec.agent.subagent", descKey: "web.settings.sec.agent.subagent.desc", keys: ["subagent.resultMode", "subagent.maxSummaryChars", "subagent.maxParallelChunkQueries", "subagent.stableSystemPrompt", "subagent.timeoutMs"] },
    { id: "agent.hallucination", titleKey: "web.settings.sec.agent.hallucination", descKey: "web.settings.sec.agent.hallucination.desc", keys: ["hallucination.judge.enabled"] },
  ],
  network: [
    { id: "network.web", titleKey: "web.settings.sec.network.web", descKey: "web.settings.sec.network.web.desc", keys: ["webSearch.enabled"] },
    { id: "network.error", titleKey: "web.settings.sec.network.error", descKey: "web.settings.sec.network.error.desc", keys: ["errorWebSearch.enabled", "errorWebSearch.threshold", "errorWebSearch.maxResults", "errorWebSearch.maxQueryChars", "errorWebSearch.maxSearchesPerSession", "errorWebSearch.requestTimeoutMs"] },
    { id: "network.service", titleKey: "web.settings.sec.network.service", descKey: "web.settings.sec.network.service.desc", keys: ["service.port", "service.host", "service.token", "service.resultRetentionDays", "service.idempotencyTtlHours", "service.syncWaitMs", "service.maxQueueLength", "service.callbackTimeoutMs", "service.webhookSecret"] },
  ],
  browser: [
    { id: "browser.main", titleKey: "web.settings.sec.browser.main", keys: ["browser.enabled", "browser.headless"] },
    { id: "browser.limits", titleKey: "web.settings.sec.browser.limits", descKey: "web.settings.sec.browser.limits.desc", keys: ["browser.maxElements", "browser.maxContentChars", "browser.maxConsoleEntries", "browser.maxConsoleLineChars"] },
    { id: "browser.viewport", titleKey: "web.settings.sec.browser.viewport", keys: ["browser.viewportWidth", "browser.viewportHeight", "browser.navigationTimeout"] },
  ],
  sessions: [
    { id: "sessions.main", titleKey: "web.settings.sec.sessions.main", descKey: "web.settings.sec.sessions.main.desc", keys: ["session.autoSave", "session.autoName", "session.maxSessions", "session.isolateMemory"] },
    { id: "sessions.isolation", titleKey: "web.settings.sec.sessions.isolation", descKey: "web.settings.sec.sessions.isolation.desc", keys: ["sessionIsolation.enabled", "sessionIsolation.isolatePlugins", "sessionIsolation.isolateTempFiles"] },
  ],
  ui: [
    { id: "ui.chat", titleKey: "web.settings.sec.ui.chat", descKey: "web.settings.sec.ui.chat.desc", keys: ["ui.fontSize", "ui.activityRail", "ui.spinner", "ui.showContextStats", "ui.showCompaction"] },
    { id: "ui.images", titleKey: "web.settings.sec.ui.images", descKey: "web.settings.sec.ui.images.desc", keys: ["images.maxCount", "images.maxBytes"] },
  ],
  security: [
    { id: "security.switches", titleKey: "web.settings.sec.security.switches", descKey: "web.settings.sec.security.switches.desc", keys: ["security.enabled", "security.bash.enabled", "security.bash.blockDangerousFlags", "security.paths.enabled", "security.contentScan.enabled", "security.network.enabled", "security.sessionEncryption.enabled"] },
    { id: "security.limits", titleKey: "web.settings.sec.security.limits", descKey: "web.settings.sec.security.limits.desc", keys: ["security.maxRecursionDepth", "security.maxFileOperations", "security.rateLimits.maxRequestsPerMinute", "security.rateLimits.maxParallelTasks", "security.network.requestTimeout", "security.network.maxResponseSize"] },
    { id: "security.bash", titleKey: "web.settings.sec.security.bash", descKey: "web.settings.sec.security.bash.desc", keys: ["security.bash.blacklist", "security.bash.whitelist", "security.bash.dangerousFlags", "security.bash.dangerousOperators"] },
    { id: "security.paths", titleKey: "web.settings.sec.security.paths", descKey: "web.settings.sec.security.paths.desc", keys: ["security.paths.denied", "security.paths.allowed"] },
    { id: "security.network", titleKey: "web.settings.sec.security.network", descKey: "web.settings.sec.security.network.desc", keys: ["security.network.deniedDomains", "security.network.allowedDomains"] },
    { id: "security.scan", titleKey: "web.settings.sec.security.scan", descKey: "web.settings.sec.security.scan.desc", keys: ["security.contentScan.dangerousPatterns"] },
    { id: "security.audit", titleKey: "web.settings.sec.security.audit", descKey: "web.settings.sec.security.audit.desc", keys: ["security.auditNotifier.enabled", "security.auditNotifier.filePath", "security.auditNotifier.webhookUrl", "security.auditNotifier.webhookTimeout", "security.auditNotifier.minSeverity", "security.auditNotifier.maxRetries", "security.auditNotifier.eventTypes"] },
    { id: "security.encryption", titleKey: "web.settings.sec.security.encryption", descKey: "web.settings.sec.security.encryption.desc", keys: ["security.sessionEncryption.encryptHistory", "security.sessionEncryption.encryptSessionLog", "security.sessionEncryption.keyPath"] },
  ],
  advanced: [
    { id: "advanced.diagnostics", titleKey: "web.settings.sec.advanced.diagnostics", descKey: "web.settings.sec.advanced.diagnostics.desc", keys: ["logLevel", "version"] },
    { id: "advanced.retry", titleKey: "web.settings.sec.advanced.retry", descKey: "web.settings.sec.advanced.retry.desc", keys: ["retry.maxRetries", "retry.baseDelay", "retry.maxDelay", "retry.maxStreamRetries", "retry.noDataTimeoutMs"] },
    { id: "advanced.service", titleKey: "web.settings.sec.advanced.service", descKey: "web.settings.sec.advanced.service.desc", keys: ["pricing.enabled", "pricing.overrides"] },
  ],
  plugins: [
    { id: "plugins.registry", titleKey: "web.settings.sec.plugins.registry", descKey: "web.settings.sec.plugins.registry.desc", keys: ["plugins.disabled", "plugins.maxDrafts"] },
    { id: "plugins.lsp", titleKey: "web.settings.sec.plugins.lsp", descKey: "web.settings.sec.plugins.lsp.desc", keys: ["lsp.enabled", "lsp.offline", "lsp.typescriptEngine"] },
  ],
};

/** Flat `key -> panelId` index (search + "where does this setting live"). */
export function keyToPanel(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [panel, sections] of Object.entries(PANEL_SECTIONS)) {
    for (const section of sections) {
      for (const key of section.keys) map.set(key, panel);
    }
  }
  return map;
}
