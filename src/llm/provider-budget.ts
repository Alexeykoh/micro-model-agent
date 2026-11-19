/** Баланс провайдера: запрос расхода/остатка (только OpenRouter по API). */
/**
 * Запрос баланса/расхода у провайдера. Поддерживается только OpenRouter —
 * единственный, кто отдаёт эти данные по API-ключу. Zen/Go баланс не
 * возвращают (только веб-дашборд), поэтому для них честно `unsupported`.
 */
import { PROVIDER_BUDGET_TIMEOUT_MS as DEFAULT_TIMEOUT_MS } from "../config/timeouts";

/** Бюджет провайдера: расход ключа, лимиты, баланс аккаунта. */
export interface ProviderBudget {
  provider: string;
  source: "openrouter";
  /** Метка ключа (OpenRouter). */
  keyLabel?: string;
  /** Расход по ключу за всё время (USD). */
  keyUsageUsd?: number;
  /** Установленный лимит ключа (USD), если задан. */
  keyLimitUsd?: number;
  /** Остаток лимита ключа (USD). */
  keyRemainingUsd?: number;
  /** Ключ на free tier. */
  isFreeTier?: boolean;
  /** Всего куплено кредитов аккаунта (management key). */
  totalCreditsUsd?: number;
  /** Всего израсходовано аккаунтом (management key). */
  totalUsageUsd?: number;
  /** Остаток баланса аккаунта = credits - usage. */
  balanceUsd?: number;
}

/** Причина итога: ok / unsupported / no-key / error. */
export type BudgetReason = "ok" | "unsupported" | "no-key" | "error";

/** Итог запроса бюджета: бюджет либо причина отсутствия. */
export interface ProviderBudgetResult {
  budget: ProviderBudget | null;
  reason: BudgetReason;
  /** Диагностика ошибки (когда `reason === "error"`). */
  error?: string;
}

/** Опции запроса: таймаут и диагностический лог. */
export interface BudgetOptions {
  /** Таймаут одного запроса (мс). */
  timeoutMs?: number;
  /** Диагностический лог; обязателен, чтобы подавляемые ошибки не терялись. */
  log: (level: "warn" | "debug", message: string) => void;
}

/** Приводит значение к конечному числу; иначе undefined. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** GET JSON с Bearer-авторизацией; не-2xx превращает в ошибку. */
async function getJson(url: string, apiKey: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Запрашивает бюджет у провайдера. Никогда не бросает: любые сбои возвращаются
 * как `reason: "error"` (и логируются), чтобы вызывающая команда показала
 * причину, а не падала.
 */
export async function fetchProviderBudget(
  provider: string,
  baseUrl: string,
  apiKey: string | undefined,
  options: BudgetOptions,
): Promise<ProviderBudgetResult> {
  if (provider !== "openrouter") {
    options.log("debug", `budget: provider "${provider}" does not expose an API balance`);
    return { budget: null, reason: "unsupported" };
  }
  if (!apiKey) {
    options.log("debug", "budget: no api key configured");
    return { budget: null, reason: "no-key" };
  }

  const base = baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const keyBody = (await getJson(`${base}/key`, apiKey, timeoutMs)) as {
      data?: Record<string, unknown>;
    };
    const data = keyBody?.data ?? {};
    const budget: ProviderBudget = { provider, source: "openrouter" };
    budget.keyLabel = typeof data.label === "string" ? data.label : undefined;
    budget.keyUsageUsd = num(data.usage);
    budget.keyLimitUsd = num(data.limit);
    budget.keyRemainingUsd = num(data.limit_remaining);
    budget.isFreeTier = typeof data.is_free_tier === "boolean" ? data.is_free_tier : undefined;

    // /credits требует management key; при отказе продолжаем с данными ключа.
    try {
      const creditsBody = (await getJson(`${base}/credits`, apiKey, timeoutMs)) as {
        data?: Record<string, unknown>;
      };
      const c = creditsBody?.data ?? {};
      budget.totalCreditsUsd = num(c.total_credits);
      budget.totalUsageUsd = num(c.total_usage);
      if (budget.totalCreditsUsd !== undefined && budget.totalUsageUsd !== undefined) {
        budget.balanceUsd = budget.totalCreditsUsd - budget.totalUsageUsd;
      }
    } catch (creditsErr) {
      options.log(
        "debug",
        `budget: /credits unavailable (${creditsErr instanceof Error ? creditsErr.message : String(creditsErr)})`,
      );
    }

    return { budget, reason: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.log("warn", `budget: request failed (${message})`);
    return { budget: null, reason: "error", error: message };
  }
}
