import type { PricingConfig } from "../../config/types";
import { calculateCostDetailed, formatCost, type CacheCostInput } from "./prices";

export interface CostBreakdownEntry {
  provider: string;
  cost: number;
}

/**
 * Accumulates per-call LLM cost for a session, attributed to the provider
 * that served the call. Call `record()` after each LLM call with the
 * (estimated or API) token usage and the provider name; read `total` for the
 * running total, `totalFor(provider)` / `breakdown()` for per-provider
 * attribution. When the model has no known price, `record` is a no-op.
 */
export class CostTracker {
  private config?: PricingConfig;
  private model: string;
  private _total = 0;
  private _saved = 0;
  private _known = false;
  private byProvider = new Map<string, { total: number; known: boolean }>();

  constructor(model: string, config?: PricingConfig) {
    this.model = model;
    this.config = config;
  }

  /** Update the model (on /model switch). Later records use the new price. */
  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Записывает usage одного LLM-вызова с атрибуцией провайдеру. `cache`
   * разделяет prompt-токены на кешированные/некешированные и накапливает
   * экономию.
   */
  record(
    promptTokens: number,
    completionTokens: number,
    provider?: string,
    cache?: CacheCostInput,
  ): void {
    const key = provider || "unknown";
    const result = calculateCostDetailed(
      this.model,
      promptTokens,
      completionTokens,
      this.config,
      cache,
    );
    if (!result) return;
    this._known = true;
    this._total += result.cost;
    this._saved += result.saved;
    let entry = this.byProvider.get(key);
    if (!entry) {
      entry = { total: 0, known: false };
      this.byProvider.set(key, entry);
    }
    entry.known = true;
    entry.total += result.cost;
  }

  /** Running total cost in USD, or undefined if no model price is known. */
  get total(): number | undefined {
    return this._known ? this._total : undefined;
  }

  /** Накопленная экономия на cache read (USD), undefined без известной цены. */
  get saved(): number | undefined {
    return this._known ? this._saved : undefined;
  }

  /** Total for one provider, or undefined when nothing was priced for it. */
  totalFor(provider: string): number | undefined {
    const entry = this.byProvider.get(provider);
    return entry?.known ? entry.total : undefined;
  }

  /** Per-provider totals sorted by cost descending (priced providers only). */
  breakdown(): CostBreakdownEntry[] {
    const entries: CostBreakdownEntry[] = [];
    for (const [provider, entry] of this.byProvider) {
      if (entry.known) entries.push({ provider, cost: entry.total });
    }
    return entries.sort((a, b) => b.cost - a.cost);
  }

  /** Human-readable total, or undefined when pricing is unavailable. */
  get formatted(): string | undefined {
    return this._known ? formatCost(this._total) : undefined;
  }
}
