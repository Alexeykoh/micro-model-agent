import type { PricingConfig } from "../../config/types";
import { calculateCost, formatCost } from "./prices";

/**
 * Accumulates per-call LLM cost for a session. Call `record()` after each LLM
 * call with the (estimated or API) token usage; read `total` for the running
 * total and `format()` for a display string. When the model has no known
 * price, `record` is a no-op and the total stays undefined.
 */
export class CostTracker {
  private config?: PricingConfig;
  private model: string;
  private _total = 0;
  private _known = false;

  constructor(model: string, config?: PricingConfig) {
    this.model = model;
    this.config = config;
  }

  /** Update the model (on /model switch). Later records use the new price. */
  setModel(model: string): void {
    this.model = model;
  }

  /** Record a single LLM call's token usage. */
  record(promptTokens: number, completionTokens: number): void {
    const cost = calculateCost(this.model, promptTokens, completionTokens, this.config);
    if (cost === undefined) return;
    this._known = true;
    this._total += cost;
  }

  /** Running total cost in USD, or undefined if no model price is known. */
  get total(): number | undefined {
    return this._known ? this._total : undefined;
  }

  /** Human-readable total, or undefined when pricing is unavailable. */
  get formatted(): string | undefined {
    return this._known ? formatCost(this._total) : undefined;
  }
}