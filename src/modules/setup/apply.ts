// Применение ответов first-run визарда на загруженный конфиг (единый путь записи).
/**
 * Применение ответов first-run визарда на загруженный конфиг.
 * Общий для терминального визарда (`src/cli/setup-order.ts` реэкспортит) и
 * браузерного (`src/modules/webui/setup-api.ts`) — единый путь записи в `AppConfig`.
 */
import type { AppConfig } from "../../config/types";
import type { SetupAnswers, SetupSecurityDetail } from "./answers";

/** Команды в довесок к bash-blacklist, если визард включил блок. */
export const SECURITY_BASH_BLOCKLIST = [
  "rm",
  "dd",
  "chmod",
  "wget",
  "curl",
  "scp",
  "ssh",
  "nc",
  "netcat",
  "sudo",
  "su",
  "kill",
  "pkill",
  "killall",
  "shutdown",
  "reboot",
];

/**
 * Применить ответы first-run визарда на загруженный конфиг.
 * Провайдер заменяется **новым объектом**, а не мутируется на месте: `loadConfig`
 * может повесить сессионный `MMA_PROVIDER_*` env-оверрайд, чей `envValue`
 * указывает на загруженный объект `config.provider`. `stripEnvOverrides` в
 * `saveConfig` матчит этот объект по identity и откатил бы весь провайдер к
 * env/дефолту, молча потеряв провайдер/URL/ключ визарда. Замена объекта
 * сохраняет протухшую identity оверрайда — вычищается только env-ключ, а ответы
 * персистятся. Активная запись `provider.entries[]` тоже переписывается
 * (type/baseUrl/apiKey и окно контекста), соседи и их тюнинг целы.
 */
export function applyAnswersToConfig(config: AppConfig, a: SetupAnswers): AppConfig {
  config.provider = {
    ...config.provider,
    type: a.provider,
    baseUrl: a.apiBase,
    apiKey: a.apiKey,
  };
  config.model = a.model;
  config.contextWindow = a.contextWindow;
  config.maxToolIterations = a.maxToolIterations;
  config.locale = a.locale;
  // Мультиконфиги резолвят активный провайдер из `entries[]`, так что ответы
  // пишутся на активную запись — без потери соседей и тюнинга записи
  // (cache, retry, rateLimits). Осознанный кастомный label сохраняется,
  // generic/дефолтный заменяется.
  if ((config.provider.entries?.length ?? 0) > 0) {
    const entries = config.provider.entries ?? [];
    const activeName =
      config.provider.active || entries[0]?.label || entries[0]?.type;
    const idx = entries.findIndex((e) => e.label === activeName || e.type === activeName);
    const target = idx >= 0 ? idx : 0;
    const current = entries[target];
    const keepLabel = Boolean(current.label && current.label !== current.type);
    const updated = {
      ...current,
      type: a.provider,
      baseUrl: a.apiBase,
      apiKey: a.apiKey,
      contextWindow: a.contextWindow,
      ...(keepLabel ? {} : { label: a.provider }),
    };
    const next = entries.slice();
    next[target] = updated;
    config.provider.entries = next;
    config.provider.active = updated.label || updated.type;
  }
  applySecurityAnswers(config, a);
  return config;
}

/**
 * Секция безопасности визарда: три тумблера шага Security плюс тонкие правки
 * из поп-апов (идут последними и переопределяют поля целиком, т.к. пользователь
 * редактировал именно их).
 */
function applySecurityAnswers(config: AppConfig, a: SetupAnswers): void {
  if (!config.security) return;
  config.security.enabled = true;
  config.security.bash.enabled = true;
  config.security.bash.blockDangerousFlags =
    a.securityFlagsBlock || config.security.bash.blockDangerousFlags;
  if (a.securityBashBlock) {
    config.security.bash.blacklist = [
      ...new Set([...config.security.bash.blacklist, ...SECURITY_BASH_BLOCKLIST]),
    ];
  }
  config.security.paths.enabled = a.securityPathsRestrict;
  if (a.securityDetail) applySecurityDetail(config.security, a.securityDetail);
}

/**
 * Наложить детали из поп-апов визарда на живой security-конфиг. Указанные поля
 * заменяются целиком (списки — как есть), `undefined`-поля не трогаются.
 * `contentScan.dangerousPatterns` не адресуется — остаётся дефолтным.
 *
 * Табличный merge: `DETAIL_FIELDS` связывает путь в `SetupSecurityDetail` с
 * путём в `SecurityConfig` (ветки `advanced.*` раскрываются в топ-уровень,
 * `rateLimits`, `contentScan`, `sessionEncryption`, `auditNotifier`).
 */

type DetailKind = "list" | "bool" | "int" | "severity";

const SEVERITIES = ["low", "medium", "high", "critical"] as const;

interface DetailField {
  /** Dotted-путь в деталях визарда. */
  from: string;
  /** Dotted-путь в security-конфиге. */
  to: string;
  kind: DetailKind;
}

const DETAIL_FIELDS: DetailField[] = [
  { from: "bash.blacklist", to: "bash.blacklist", kind: "list" },
  { from: "bash.whitelist", to: "bash.whitelist", kind: "list" },
  { from: "bash.logCommands", to: "bash.logCommands", kind: "bool" },
  { from: "paths.denied", to: "paths.denied", kind: "list" },
  { from: "paths.allowed", to: "paths.allowed", kind: "list" },
  { from: "flags.dangerousFlags", to: "bash.dangerousFlags", kind: "list" },
  { from: "flags.dangerousOperators", to: "bash.dangerousOperators", kind: "list" },
  { from: "network.enabled", to: "network.enabled", kind: "bool" },
  { from: "network.deniedDomains", to: "network.deniedDomains", kind: "list" },
  { from: "network.allowedDomains", to: "network.allowedDomains", kind: "list" },
  { from: "network.requestTimeout", to: "network.requestTimeout", kind: "int" },
  { from: "network.maxResponseSize", to: "network.maxResponseSize", kind: "int" },
  { from: "advanced.maxRecursionDepth", to: "maxRecursionDepth", kind: "int" },
  { from: "advanced.maxFileOperations", to: "maxFileOperations", kind: "int" },
  { from: "advanced.maxRequestsPerMinute", to: "rateLimits.maxRequestsPerMinute", kind: "int" },
  { from: "advanced.maxParallelTasks", to: "rateLimits.maxParallelTasks", kind: "int" },
  { from: "advanced.contentScanEnabled", to: "contentScan.enabled", kind: "bool" },
  { from: "advanced.sessionEncryptionEnabled", to: "sessionEncryption.enabled", kind: "bool" },
  { from: "advanced.auditNotifierEnabled", to: "auditNotifier.enabled", kind: "bool" },
  { from: "advanced.auditNotifierMinSeverity", to: "auditNotifier.minSeverity", kind: "severity" },
  { from: "advanced.auditNotifierEventTypes", to: "auditNotifier.eventTypes", kind: "list" },
  { from: "advanced.auditNotifierMaxRetries", to: "auditNotifier.maxRetries", kind: "int" },
  { from: "advanced.auditNotifierWebhookTimeout", to: "auditNotifier.webhookTimeout", kind: "int" },
];

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function writePath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function isFieldValue(v: unknown, kind: DetailKind): boolean {
  if (kind === "list") return Array.isArray(v) && v.every((x) => typeof x === "string");
  if (kind === "bool") return typeof v === "boolean";
  if (kind === "int") return typeof v === "number" && Number.isInteger(v) && v > 0;
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

export function applySecurityDetail(
  security: NonNullable<AppConfig["security"]>,
  detail: SetupSecurityDetail,
): void {
  const target = security as unknown as Record<string, unknown>;
  for (const field of DETAIL_FIELDS) {
    const value = readPath(detail, field.from);
    if (!isFieldValue(value, field.kind)) continue;
    writePath(target, field.to, Array.isArray(value) ? [...value] : value);
  }
}
