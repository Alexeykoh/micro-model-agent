/** Поля поп-апа тонкой настройки безопасности (списки, флаги, числа). */
import { h } from "./setup-dom.js";
import { tr } from "./setup-i18n.js";
import type { Dict } from "./setup-state.js";

/** Описание поп-апов тонкой настройки: путь в securityDetail + тип поля. */
export const SECURITY_POPUPS: Record<string, Array<[string, string, string]>> = {
  paths: [
    ["paths.denied", "list", "web.setup.security.denied"],
    ["paths.allowed", "list", "web.setup.security.allowed"],
  ],
  bash: [
    ["bash.blacklist", "list", "web.setup.security.blacklist"],
    ["bash.whitelist", "list", "web.setup.security.whitelist"],
    ["bash.logCommands", "bool", "web.setup.security.log_commands"],
  ],
  flags: [
    ["flags.dangerousFlags", "list", "web.setup.security.dangerous_flags"],
    ["flags.dangerousOperators", "list", "web.setup.security.dangerous_operators"],
  ],
  advanced: [
    ["network.enabled", "bool", "web.setup.security.network_enabled"],
    ["network.deniedDomains", "list", "web.setup.security.denied_domains"],
    ["network.allowedDomains", "list", "web.setup.security.allowed_domains"],
    ["network.requestTimeout", "int", "web.setup.security.request_timeout"],
    ["network.maxResponseSize", "int", "web.setup.security.max_response_size"],
    ["advanced.maxRecursionDepth", "int", "web.setup.security.max_recursion"],
    ["advanced.maxFileOperations", "int", "web.setup.security.max_file_ops"],
    ["advanced.maxRequestsPerMinute", "int", "web.setup.security.rate_rpm"],
    ["advanced.maxParallelTasks", "int", "web.setup.security.rate_parallel"],
    ["advanced.contentScanEnabled", "bool", "web.setup.security.content_scan"],
    ["advanced.sessionEncryptionEnabled", "bool", "web.setup.security.session_encryption"],
    ["advanced.auditNotifierEnabled", "bool", "web.setup.security.audit_enabled"],
    ["advanced.auditNotifierMinSeverity", "enum", "web.setup.security.audit_severity"],
    ["advanced.auditNotifierEventTypes", "list", "web.setup.security.audit_events"],
    ["advanced.auditNotifierMaxRetries", "int", "web.setup.security.audit_retries"],
    ["advanced.auditNotifierWebhookTimeout", "int", "web.setup.security.audit_timeout"],
  ],
};

export const SEVERITIES = ["low", "medium", "high", "critical"];

/** Группы поп-апа → ключи `securityDetail`, которые сбрасывает кнопка Reset. */
export const GROUP_KEYS: Record<string, string[]> = {
  paths: ["paths"],
  bash: ["bash"],
  flags: ["flags"],
  advanced: ["network", "advanced"],
};

export function getPath(obj: Dict, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Dict)[k]), obj);
}

export function setPath(obj: Dict, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur: Dict = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

export function popupField(detail: Dict, path: string, type: string, label: string): HTMLElement {
  const wrap = h("div", "setup-field");
  if (type === "list") {
    wrap.appendChild(h("label", "setup-label", label));
    const ta = h("textarea", "setup-input setup-textarea");
    const cur = getPath(detail, path);
    ta.value = Array.isArray(cur) ? (cur as string[]).join("\n") : "";
    ta.rows = 5;
    ta.spellcheck = false;
    ta.addEventListener("input", () => {
      const items = ta.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      setPath(detail, path, items);
    });
    wrap.appendChild(ta);
  } else if (type === "bool") {
    const row = h("label", "setup-toggle");
    const cb = h("input");
    cb.type = "checkbox";
    cb.checked = Boolean(getPath(detail, path));
    cb.addEventListener("change", () => setPath(detail, path, cb.checked));
    row.appendChild(cb);
    row.appendChild(h("span", "t", label));
    wrap.appendChild(row);
  } else if (type === "int") {
    wrap.appendChild(h("label", "setup-label", label));
    const inp = h("input", "setup-input");
    inp.type = "number";
    inp.min = "1";
    const cur = getPath(detail, path);
    inp.value = typeof cur === "number" ? String(cur) : "";
    inp.addEventListener("input", () => {
      const n = parseInt(inp.value, 10);
      setPath(detail, path, Number.isFinite(n) && n > 0 ? n : undefined);
    });
    wrap.appendChild(inp);
  } else if (type === "enum") {
    wrap.appendChild(h("label", "setup-label", label));
    const sel = h("select", "setup-input");
    const cur = getPath(detail, path);
    SEVERITIES.forEach((sev) => {
      const opt = h("option", null, tr("web.setup.security.severity." + sev));
      opt.value = sev;
      if (cur === sev) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => setPath(detail, path, sel.value));
    wrap.appendChild(sel);
  }
  return wrap;
}
