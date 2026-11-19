// Трекер стоимости сессии: накопление цены LLM-вызовов с атрибуцией провайдеру.
import type { PricingConfig } from "../../config/types";
import { calculateCostDetailed, formatCost, type CacheCostInput } from "./prices";

/** Одна строка разбивки: провайдер и его суммарная стоимость. */
export interface CostBreakdownEntry {
  provider: string;
  cost: number;
}

/**
 * Копит стоимость LLM-вызовов сессии с атрибуцией обслужившему провайдеру.
 * После каждого вызова — `record()` с usage (оценочным или API) и именем
 * провайдера; `total` даёт running-итог, `totalFor(provider)` / `breakdown()` —
 * разбивку. Без известной цены модели `record` — no-op.
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

  /** Сменяет модель (при /model switch). Дальнейшие записи — по новой цене. */
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

  /**
   * Записывает стоимость, которую сообщил провайдер (авторитетнее оценки по
   * токенам). `cache` всё равно учитывается для накопленной экономии.
   */
  recordActual(cost: number, provider?: string, cache?: CacheCostInput): void {
    if (!Number.isFinite(cost) || cost < 0) return;
    const key = provider || "unknown";
    this._known = true;
    this._total += cost;
    if (cache) {
      const priced = calculateCostDetailed(
        this.model,
        cache.cachedTokens ?? 0,
        0,
        this.config,
        cache,
      );
      if (priced) this._saved += priced.saved;
    }
    let entry = this.byProvider.get(key);
    if (!entry) {
      entry = { total: 0, known: false };
      this.byProvider.set(key, entry);
    }
    entry.known = true;
    entry.total += cost;
  }

  /** Итоговая стоимость в USD; undefined без известной цены модели. */
  get total(): number | undefined {
    return this._known ? this._total : undefined;
  }

  /** Накопленная экономия на cache read (USD), undefined без известной цены. */
  get saved(): number | undefined {
    return this._known ? this._saved : undefined;
  }

  /** Итог по одному провайдеру; undefined, если по нему ничего не оценено. */
  totalFor(provider: string): number | undefined {
    const entry = this.byProvider.get(provider);
    return entry?.known ? entry.total : undefined;
  }

  /** Итоги по провайдерам по убыванию стоимости (только оценённые). */
  breakdown(): CostBreakdownEntry[] {
    const entries: CostBreakdownEntry[] = [];
    for (const [provider, entry] of this.byProvider) {
      if (entry.known) entries.push({ provider, cost: entry.total });
    }
    return entries.sort((a, b) => b.cost - a.cost);
  }

  /** Читаемый итог; undefined, когда цен нет. */
  get formatted(): string | undefined {
    return this._known ? formatCost(this._total) : undefined;
  }
}
