/**
 * Валидация ответов визарда первого запуска (split W11): общая для
 * браузерного визарда и демона. Чистые функции без I/O.
 */
import { AUDIT_EVENT_TYPES } from "../config/registry-extra";
import { THEME_MODES, UI_THEME_IDS, type ThemeMode, type UiThemeId } from "../config/theme-ids";
import {
  SETUP_LANGUAGES,
  type SetupAnswers,
  type SetupSecurityDetail,
  type SetupSoundAnswers,
} from "../modules/setup/answers";

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Положительный int, числовая строка принимается; `null` — мусор. */
function positiveInt(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Громкость звука: 0–100, дробные и мусор отбрасываются. */
function optVolume(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
}

/** Частичные звуковые ответы: валидные поля, мусор отбрасывается по одному. */
function parseSounds(v: unknown): SetupSoundAnswers | undefined {
  if (!v || typeof v !== "object") return undefined;
  const rec = v as Record<string, unknown>;
  const out: SetupSoundAnswers = {};
  for (const key of ["enabled", "done", "question", "failed"] as const) {
    if (typeof rec[key] === "boolean") out[key] = rec[key] as boolean;
  }
  const volume = optVolume(rec.volume);
  if (volume !== undefined) out.volume = volume;
  return Object.keys(out).length ? out : undefined;
}

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const MAX_DETAIL_LIST = 200;
const MAX_DETAIL_ITEM = 200;

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "" && x.length <= MAX_DETAIL_ITEM)
    .slice(0, MAX_DETAIL_LIST);
}

function optBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function optInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Санитайзер тонкой настройки безопасности из поп-апов. Незнакомые поля и
 * неверные типы отбрасываются (fail-open к дефолтам конфига), списки
 * ограничены по длине. `undefined`-поля не трогаются при применении.
 */
export function parseSecurityDetail(v: unknown): SetupSecurityDetail | undefined {
  if (!v || typeof v !== "object") return undefined;
  const rec = v as Record<string, unknown>;
  const detail: SetupSecurityDetail = {};

  const bash = rec.bash as Record<string, unknown> | undefined;
  if (bash && typeof bash === "object") {
    detail.bash = {
      blacklist: strList(bash.blacklist),
      whitelist: strList(bash.whitelist),
      logCommands: optBool(bash.logCommands),
    };
  }
  const paths = rec.paths as Record<string, unknown> | undefined;
  if (paths && typeof paths === "object") {
    detail.paths = { denied: strList(paths.denied), allowed: strList(paths.allowed) };
  }
  const flags = rec.flags as Record<string, unknown> | undefined;
  if (flags && typeof flags === "object") {
    detail.flags = {
      dangerousFlags: strList(flags.dangerousFlags),
      dangerousOperators: strList(flags.dangerousOperators),
    };
  }
  const network = rec.network as Record<string, unknown> | undefined;
  if (network && typeof network === "object") {
    detail.network = {
      enabled: optBool(network.enabled),
      deniedDomains: strList(network.deniedDomains),
      allowedDomains: strList(network.allowedDomains),
      requestTimeout: optInt(network.requestTimeout),
      maxResponseSize: optInt(network.maxResponseSize),
    };
  }
  const adv = rec.advanced as Record<string, unknown> | undefined;
  if (adv && typeof adv === "object") {
    const rawSev = adv.auditNotifierMinSeverity;
    const sev =
      typeof rawSev === "string" && (SEVERITIES as readonly string[]).includes(rawSev)
        ? (rawSev as (typeof SEVERITIES)[number])
        : undefined;
    detail.advanced = {
      maxRecursionDepth: optInt(adv.maxRecursionDepth),
      maxFileOperations: optInt(adv.maxFileOperations),
      maxRequestsPerMinute: optInt(adv.maxRequestsPerMinute),
      maxParallelTasks: optInt(adv.maxParallelTasks),
      contentScanEnabled: optBool(adv.contentScanEnabled),
      sessionEncryptionEnabled: optBool(adv.sessionEncryptionEnabled),
      auditNotifierEnabled: optBool(adv.auditNotifierEnabled),
      auditNotifierMinSeverity: sev,
      auditNotifierEventTypes: strList(adv.auditNotifierEventTypes)?.filter((e) =>
        (AUDIT_EVENT_TYPES as readonly string[]).includes(e),
      ),
      auditNotifierMaxRetries: optInt(adv.auditNotifierMaxRetries),
      auditNotifierWebhookTimeout: optInt(adv.auditNotifierWebhookTimeout),
    };
  }
  return detail;
}

/** Валидирует тело `POST /api/setup`; `null` — реджект с 400. */
export function parseSetupAnswers(rec: Record<string, unknown>): SetupAnswers | null {
  // Шаг 2.0 «Пропустить»: провайдер, модель и контекст не заданы — остаются
  // текущие значения конфига (на virgin-конфиге это DEFAULTS).
  const configureProvider = rec.configureProvider !== false;
  let provider = "";
  let apiBase = "";
  let model = "";
  let contextWindow = 0;
  let maxToolIterations = 0;
  if (configureProvider) {
    provider = str(rec, "provider");
    apiBase = str(rec, "apiBase");
    model = str(rec, "model");
    if (!provider || !apiBase || !model) return null;

    const cw = positiveInt(rec, "contextWindow");
    const it = positiveInt(rec, "maxToolIterations");
    if (cw === null || it === null) return null;
    contextWindow = cw;
    maxToolIterations = it;
  }

  const locale = str(rec, "locale");
  if (!SETUP_LANGUAGES.some((l) => l.value === locale)) return null;

  const flags = ["securityBashBlock", "securityFlagsBlock", "securityPathsRestrict"] as const;
  for (const key of flags) {
    if (typeof rec[key] !== "boolean") return null;
  }

  const apiKey =
    typeof rec.apiKey === "string" && rec.apiKey.trim() ? rec.apiKey.trim() : "not-needed";
  const rawTheme = rec.theme;
  const theme =
    typeof rawTheme === "string" && (UI_THEME_IDS as readonly string[]).includes(rawTheme)
      ? (rawTheme as UiThemeId)
      : undefined;
  const rawMode = rec.themeMode;
  const themeMode =
    typeof rawMode === "string" && (THEME_MODES as readonly string[]).includes(rawMode)
      ? (rawMode as ThemeMode)
      : undefined;

  const out: SetupAnswers = {
    provider,
    apiBase,
    apiKey,
    model,
    contextWindow,
    maxToolIterations,
    locale,
    securityBashBlock: rec.securityBashBlock as boolean,
    securityFlagsBlock: rec.securityFlagsBlock as boolean,
    securityPathsRestrict: rec.securityPathsRestrict as boolean,
    securityDetail: parseSecurityDetail(rec.securityDetail),
    configureProvider,
    contextAuto: optBool(rec.contextAuto),
    criticEnabled: optBool(rec.criticEnabled),
    webSearchEnabled: optBool(rec.webSearchEnabled),
    theme,
    themeMode,
    themeEffects: optBool(rec.themeEffects),
    sounds: parseSounds(rec.sounds),
  };
  if (typeof rec.soundsEnabled === "boolean") out.soundsEnabled = rec.soundsEnabled;
  return out;
}
