// Бюджет контекста: разбивка окна на system/reserve/history и доли.
import type { AppConfig } from "./types";
import { t } from "../i18n/index";

/** Какая доля меняется: system или reserve. */
export type BudgetShareKey = "system" | "reserve";

const MIN_SHARE = 0.05;
const MAX_SHARE = 0.9;
/** system + reserve обязаны оставить место под историю. */
const MAX_COMBINED = 0.95;

/** Разбивка контекстного окна в токенах и долях. */
export interface BudgetBreakdown {
  window: number;
  system: number;
  reserve: number;
  history: number;
  systemFraction: number;
  reserveFraction: number;
  historyFraction: number;
}

/** Режет окно контекста на части system / reserve / history. */
export function budgetBreakdown(config: AppConfig): BudgetBreakdown {
  const window = config.contextWindow;
  const budget = config.contextBudget;
  const system = Math.floor(window * budget.systemPrompt);
  const reserve = Math.floor(window * budget.responseReserve);
  const history = window - system - reserve;
  return {
    window,
    system,
    reserve,
    history,
    systemFraction: budget.systemPrompt,
    reserveFraction: budget.responseReserve,
    historyFraction: window > 0 ? history / window : 0,
  };
}

/**
 * Проверяет и применяет смену доли. При неуспехе возвращает причину
 * (`"range"` или `"combined"`), при успехе — null. Причину локализует вызывающий.
 */
export function setBudgetShare(
  config: AppConfig,
  key: BudgetShareKey,
  value: number,
): "range" | "combined" | null {
  if (!Number.isFinite(value) || value < MIN_SHARE || value > MAX_SHARE) return "range";
  const budget = config.contextBudget;
  const nextSystem = key === "system" ? value : budget.systemPrompt;
  const nextReserve = key === "reserve" ? value : budget.responseReserve;
  if (nextSystem + nextReserve > MAX_COMBINED) return "combined";
  budget[key === "system" ? "systemPrompt" : "responseReserve"] = value;
  return null;
}

/** Локализованные строки разбивки бюджета (общие для `mma context` и `/context`). */
export function budgetBreakdownLines(config: AppConfig): string[] {
  const bd = budgetBreakdown(config);
  const pct = (f: number) => Math.round(f * 100);
  return [
    t("cli.context_budget_header", { window: bd.window }),
    t("cli.context_system_line", { tokens: bd.system, percent: pct(bd.systemFraction) }),
    t("cli.context_reserve_line", { tokens: bd.reserve, percent: pct(bd.reserveFraction) }),
    t("cli.context_history_line", { tokens: bd.history, percent: pct(bd.historyFraction) }),
  ];
}
