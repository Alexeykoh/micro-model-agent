// Миграции устаревших значений конфига (легаси-нормализация после загрузки).
//
// Вынесено из `config.ts`: файл уже на потолке правила «≤300 строк», а
// миграции обязаны быть рядом (обе — про «старое значение в персисте, которое
// пережило смену дефолта»), но не обязаны жить в загрузчике.
//
// 1) LSP: pre-0.41.1 вызовы `npx`-серверов заменяются на актуальные дефолты.
// 2) Критик: авто-персистнутый `critic.timeoutMs: 15000` (дефолт 25.09–12.10)
//    заменяется на текущий дефолт. Иначе критик обрывается на 15-й секунде —
//    раньше провайдерского дедлайна — и молча fail-open'ится.
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";
import { DEFAULTS } from "./defaults";
import { LLM_REQUEST_TIMEOUT_MS } from "./timeouts";
import { t } from "../i18n/index";
import { defaultOutputBus } from "../output";
import type { AppConfig, CriticConfig } from "./types";

/** Legacy npx-`args` LSP-серверов, предшествующие фикс. вызову. */
const LEGACY_LSP_SERVER_ARGS: Record<string, { args: string[]; timeout: number }> = {
  typescript: { args: ["typescript-language-server", "--stdio"], timeout: 30000 },
  javascript: { args: ["typescript-language-server", "--stdio"], timeout: 30000 },
  json: { args: ["vscode-json-languageserver", "--stdio"], timeout: 30000 },
  html: { args: ["vscode-html-languageserver", "--stdio"], timeout: 60000 },
  css: { args: ["vscode-css-languageserver", "--stdio"], timeout: 60000 },
};

/** Заменяет протухшие pre-0.41.1 вызовы LSP-серверов текущими дефолтами. */
export function normalizeLspServerArgs(config: AppConfig): void {
  const servers = config.lsp?.servers;
  if (!servers) return;
  for (const [lang, legacy] of Object.entries(LEGACY_LSP_SERVER_ARGS)) {
    const server = servers[lang];
    const def = DEFAULT_LSP_CONFIG.servers[lang];
    if (server?.command !== "npx" || !def) continue;
    const storedArgs = Array.isArray(server.args) ? server.args : null;
    const isLegacy =
      storedArgs === null || JSON.stringify(storedArgs) === JSON.stringify(legacy.args);
    if (isLegacy) {
      server.args = def.args;
      server.timeout = def.timeout;
    }
  }
}

/** Устаревший дефолт `critic.timeoutMs` (25.09–12.10.2026): 15 секунд. */
export const LEGACY_CRITIC_TIMEOUT_MS = 15_000;

/** Итог миграции персиста. */
export type CriticTimeoutMigration =
  | { migrated: false }
  | { migrated: true; from: number; to: number };

/** Сырой (персистнутый) домен `critic` — частичный, без дефолтов. */
type RawCritic = Partial<CriticConfig> & { provider?: unknown };

/**
 * True, если персист — целиком исторический авто-дефолт домена `critic`.
 * Любое другое значение (своя модель, свой провайдер, свои лимиты) означает
 * ручную настройку, которую миграция не трогает.
 */
function isLegacyAutoDefault(raw: RawCritic): boolean {
  const noModel = raw.model === undefined || String(raw.model).trim() === "";
  const noProvider =
    raw.provider === undefined || (typeof raw.provider === "string" && raw.provider.trim() === "");
  return (
    (raw.enabled === undefined || raw.enabled === true) &&
    (raw.tools === undefined || raw.tools === true) &&
    (raw.maxCalls === undefined || raw.maxCalls === 4) &&
    (raw.maxRepairCycles === undefined || raw.maxRepairCycles === 1) &&
    raw.maxTokens === undefined &&
    noModel &&
    noProvider
  );
}

/**
 * Мигрирует устаревший авто-дефолт таймаута в СЫРОМ персисте.
 * Мутирует переданный объект (он ещё не смержен с DEFAULTS).
 */
export function migratePersistedCriticTimeout(
  raw: { critic?: RawCritic } | null | undefined,
): CriticTimeoutMigration {
  const critic = raw?.critic;
  if (!critic) return { migrated: false };
  if (critic.timeoutMs !== LEGACY_CRITIC_TIMEOUT_MS) return { migrated: false };
  if (!isLegacyAutoDefault(critic)) return { migrated: false };
  critic.timeoutMs = DEFAULTS.critic.timeoutMs;
  return {
    migrated: true,
    from: LEGACY_CRITIC_TIMEOUT_MS,
    to: DEFAULTS.critic.timeoutMs,
  };
}

/**
 * Мигрирует сырой персист и сообщает о миграции. Вызывается ДО слияния с
 * DEFAULTS: иначе «персист == дефолт» не отличить от «юзер выбрал руками».
 */
export function applyCriticTimeoutMigration(raw: { critic?: RawCritic } | null | undefined): void {
  const state = migratePersistedCriticTimeout(raw);
  if (!state.migrated) return;
  defaultOutputBus.log(
    "info",
    "module:config",
    t("config.critic_timeout_migrated", { from: state.from, to: state.to }),
  );
}

/** Состояние ЭФФЕКТИВНОГО таймаута после слияния конфигов. */
export interface CriticTimeoutCheck {
  /** Эффективный таймаут одного вызова критика, мс. */
  value: number;
  /**
   * true — таймаут короче провайдерского дедлайна: критик оборвётся раньше
   * модели. Значение legal (D7), но молчать о нём нельзя.
   */
  tooShort: boolean;
}

/** Проверяет эффективный таймаут критика (после слияния всех конфигов). */
export function checkCriticTimeout(config: AppConfig): CriticTimeoutCheck {
  const value = config.critic?.timeoutMs ?? DEFAULTS.critic.timeoutMs;
  return { value, tooShort: value < LLM_REQUEST_TIMEOUT_MS };
}

/**
 * Предупреждает о слишком коротком ЭФФЕКТИВНОМ таймауте критика: он короче
 * провайдерского дедлайна, значит критик оборвётся раньше ответа модели.
 * Значение legal (D7: короткий таймаут — осознанный выбор), но молчать о нём
 * нельзя: fail-open неотличим от успешной проверки (INV-15).
 */
export function reportShortCriticTimeout(config: AppConfig): void {
  const { value, tooShort } = checkCriticTimeout(config);
  if (!tooShort) return;
  defaultOutputBus.log(
    "warn",
    "module:config",
    t("config.critic_timeout_short", { value, provider: LLM_REQUEST_TIMEOUT_MS }),
  );
}
