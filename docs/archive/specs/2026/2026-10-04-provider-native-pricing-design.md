# Provider-Native Pricing (trust-first)

> **Status: DRAFT — NEEDS REWORK. Do not implement as-is.** A self-review found
> unresolved contradictions and gaps (see [Review findings](#review-findings-must-address-before-implementation)
> at the bottom). The design direction is approved; the spec must be revised and
> re-approved before a plan is written.

- **Date:** 2026-10-04
- **Branch:** `feat/provider-native-pricing`
- **Version target:** 2.19.0 (MINOR)

## Problem

Token cost is computed from a hand-maintained hardcoded table (`ZEN_PRICES`,
`src/modules/pricing/prices.ts`). It goes stale silently: `deepseek-v4.1-flash`
(used by the `opencode-go` provider) was missing entirely, so `resolvePrice`
returned `undefined` and no cost was shown anywhere. Other entries were stale
too (e.g. `deepseek-v4-flash` `0.22/0.66` vs. the documented `0.15/0.60`).

A stale or wrong number is worse than no number: the user cannot trust it. The
requirement is therefore **reliability first** — cost must come from an
authoritative source (the provider itself), and when the provider does not
publish a price, MMA must say so rather than display a fabricated value.

## Research: how agents obtain prices

| Source | What it gives | Reliability |
| --- | --- | --- |
| Provider `/models` | OpenRouter: `pricing.{prompt,completion,input_cache_read,input_cache_write}` (USD **per token**, decimal strings) + `overrides` (peak/off-peak, long-context). OpenAI/Anthropic/local: no pricing. | High (vendor) |
| Provider response | OpenRouter (and some gateways): actual billed `usage.cost` / cache discount when requested. | Highest (real charge) |
| opencode Zen/Go `/models` | Verified: only `{id, object, created, owned_by}` — **no price**. | n/a |
| opencode Zen/Go response | Verified: only `usage.{prompt,completion,total,prompt_tokens_details.cached_tokens,completion_tokens_details.reasoning_tokens}` — **no cost**. | n/a |
| models.dev `api.json` | Third-party/vendor catalog with `[cost]` per model. | Rejected by product decision |
| LiteLLM `model_prices_and_context_window.json` | Community table (~3800 models). | Rejected by product decision |
| Hardcoded docs snapshot | Current `ZEN_PRICES`. | Removed by product decision |

Common harness pattern (LiteLLM auto-sync, `agent-walker`, `hermes-agent`): local
cache with TTL, fail-open (keep last good snapshot on a failed fetch), validation
of absurd rates, provenance (source/revision). MMA adopts the **cache + fail-open
+ validation + provenance** mechanics but restricts the **source** to the
provider.

## Goals

- Cost is derived only from provider-native data:
  1. the actual cost reported by the provider in the API response; else
  2. the provider's own `/models` pricing; else
  3. explicit user override (`pricing.overrides`).
- When no trustworthy price exists, show an explicit "price unavailable" state,
  never a synthesized number.
- Remove the hardcoded `ZEN_PRICES` table.
- Make provenance visible so "reliable" is verifiable, not asserted.

## Non-goals

- No third-party/community pricing catalogs (models.dev, LiteLLM).
- No per-provider scraping of docs.
- No enforcement / budget caps (separate concern).
- No changes to the token accounting itself (still OpenAI-compatible usage).

## Design

### 1. Provider pricing capability

New optional capability, mirroring `ProviderCapabilities.cache`:

```ts
// src/config/types.ts
export interface PricingCapability {
  /** How the provider exposes price. Default: none. */
  source: "response" | "models" | "none";
  /**
   * For `models`: JSON path/field carrying per-token pricing in the provider's
   * /models payload (fixed to OpenRouter's `pricing` object in v1; kept
   * extensible for self-hosted OpenAI-compatible gateways that include pricing).
   */
  modelsField?: string;
}

export interface ProviderCapabilities {
  // ...existing...
  pricing?: PricingCapability;
}
```

Per-entry override: `provider.entries[].pricing` (same precedence as
`entries[].cache`), resolved by `resolvePricingCapability` and threaded by
`ProviderManager.build()`.

Presets (`src/modules/providers/presets.ts`):

| Provider | `pricing.source` |
| --- | --- |
| `openrouter` | `response` (falls back to `models`) |
| `opencode-zen`, `opencode-go` | `none` |
| `lmstudio`, `openai-compat` | `none` |
| `openai` | `none` |
| `anthropic` | `none` |

Explicit `none` everywhere except OpenRouter makes the policy auditable: no
provider is silently priced.

### 2. Cost resolution precedence

Per LLM call there are two distinct layers — an exact per-call figure, and a
fallback price table:

1. **Provider-reported actual cost** (`usage.cost` in the response, when the
   provider supplies it) — used directly for that call; bypasses the price table
   entirely. It is the real charge, so it always wins for that call. Recorded as
   `source: "provider-response"`.
2. Otherwise compute from a price table, resolved in this order:
   1. **`pricing.overrides`** (user) — `source: "override"`;
   2. **Provider `/models` price** (cached) — `source: "provider"`;
   3. **No source** → no cost for the call.

The session cost stays `undefined` until any call yields a trustworthy number
(from a reported cost or a resolved price).

If some calls produce cost and others do not, `CostTracker.total` is defined
from the priced calls; `--json` exposes provenance so consumers know the figure
is partial.

### 3. Provider-reported cost

`src/llm/openai-compat.ts`:

- When the resolved pricing capability is `response`, send
  `usage: { include: true }` in the request body (OpenRouter requirement) in
  addition to the existing `stream_options.include_usage`.
- Parse a reported cost from the usage object into a new optional
  `Chunk.usage.cost` field: OpenRouter `usage.cost` (credits == USD) and optional
  `usage.cache_discount`. Non-stream path parses the same shape.
- Absent/zero-invalid → leave `undefined` (never treat missing as 0).

`src/core/types.ts`: add `cost?: number` (and `cacheDiscount?: number`) to the
usage chunk type.

`src/core/agent/token-tracker.ts`: when `usage.cost` is present, record the
actual cost via a new `CostTracker.recordReported(cost, provider?, cacheDiscount?)`
instead of the price-table calculation. This makes OpenRouter cost exact,
including its conditional/peak pricing that a flat table cannot capture.

### 4. Remove `ZEN_PRICES`

`src/modules/pricing/prices.ts` is reduced to:

- `normalizeModelId` (unchanged);
- `resolvePrice(model, config)` → `pricing.overrides[model]` (or normalized)
  only; the built-in table is deleted;
- `calculateCostDetailed` / `calculateCost` (keep signatures; return `undefined`
  when no price), `formatCost` (unchanged).

Provider `/models` prices are supplied by the pricing cache (below) and merged
into the resolution: `resolvePrice` consults overrides first, then the active
provider's cached price for the active provider, then gives up.

> Consequence (accepted): `opencode-zen`/`opencode-go` models show no cost unless
> the user sets `pricing.overrides`. Local models show an explicit "free".

### 5. Pricing cache & lifecycle

`src/modules/pricing/provider-price.ts`:

- `fetchProviderPrices(baseUrl, apiKey, capability, opts)` → parse the provider's
  `/models` payload into `Record<modelId, ModelPrice>` where `ModelPrice` is in
  **USD per 1M tokens** (multiply per-token decimals by `1e6`).
  - OpenRouter field mapping: `pricing.prompt → input`,
    `pricing.completion → output`,
    `pricing.input_cache_read → cachedInput`,
    `pricing.input_cache_write → cacheWrite`.
  - `pricing.overrides` (OpenRouter peak/off-peak, long-context): **out of scope
    in v1** — the top-level price applies; documented limitation.
- Persist a slim projection to `~/.mma/pricing-cache.json`
  (override `MMA_PRICING_CACHE`), keyed by provider identity:

  ```json
  {
    "ts": "2026-10-04T...Z",
    "source": "https://openrouter.ai/api/v1/models",
    "revision": "<etag|sha|created-hash>",
    "models": {
      "openai/gpt-4o": { "input": 2.5, "output": 10, "cachedInput": 1.25 }
    }
  }
  ```

- TTL **24h** (constant in `src/config/timeouts.ts`). Stale cache is used when a
  refresh fails; a failed fetch never blanks a good snapshot.
- Fetch is backgrounded at bootstrap (`bootstrap`) and on
  `Agent.reconfigure` when the active provider/model changes — never blocks the
  first turn. Diagnostics via `logger.diagnostic` only.
- Validation: reject non-finite, negative, or absurd rates (> $1 per token, i.e.
  > `1e6` per 1M) so a bad upstream entry cannot poison estimates.
- Only providers with `listModels: true` and `pricing.source !== "none"` are
  fetched.

### 6. Provenance & UI

- `CostTracker` tracks the dominant source for the session
  (`override | provider-response | provider | local | none`) plus per-call
  attribution.
- `session.jsonl` `llm_usage` records `costSource` and (when available)
  `costUsd`/`reportedCost`.
- Terminal (`renderer`, `run-result`, REPL context bar) and web sidebar:
  - priced cloud → `cost $X` (as today);
  - local provider → `free` (no fabricated `$0.00`);
  - provider `none` with no override → `price unavailable` (i18n), never omitted
    silently, never `$0.00`.
- `--json` adds `costSource`; `totalCost` remains `number | null` (contract
  preserved).

### 7. Data flow

```
bootstrap / reconfigure
  └─ active provider capability.pricing
       ├─ source=response|models & listModels → fetch /models (TTL, cache)  ─┐
       └─ else                                → no fetch                    │
                                                                             ▼
LLM call ── openai-compat ── response.usage                                provider-price cache
   ├── usage.cost present? → recordReported(cost)  ──► CostTracker           │
   └── else → resolvePrice(override → cache) ───────► calculateCost ──► CostTracker
                                                          │
                                             source: none → undefined
                                                          ▼
                                    renderer / run-result / web / --json / session.jsonl
```

### 8. Config

- `pricing.enabled` (existing) — master switch.
- `pricing.overrides` (existing) — user table, still first priority.
- `pricing.autoFetch` (new, default `true`) — allow provider `/models` pricing
  refresh; `false` = overrides only.
- `pricing.cacheTtlHours` (new, default `24`).
- Per-entry `provider.entries[].pricing` override of the capability.
- New env override `MMA_PRICING_CACHE` (path) — registered in `src/config/env.ts`
  (`MMA_ENV`), read at call time like the existing `MMA_MODELS_DEV_CACHE`.
- Web Settings → Advanced: surface `pricing.autoFetch` / `pricing.cacheTtlHours`;
  show resolved source for the active model.

### 9. Files

| Area | Path |
| --- | --- |
| Capability types/resolver | `src/config/types.ts`, `src/modules/providers/capabilities.ts` (or new `pricing-capability.ts`) |
| Presets | `src/modules/providers/presets.ts` |
| Provider price fetch/parse/cache | `src/modules/pricing/provider-price.ts` (new) |
| Price resolution / math | `src/modules/pricing/prices.ts` (table removed) |
| Cost accumulation | `src/modules/pricing/index.ts` (`recordReported`, `source`) |
| Request/parse reported cost | `src/llm/openai-compat.ts`, `src/core/types.ts` |
| Token→cost wiring | `src/core/agent/token-tracker.ts` |
| Bootstrap/reconfigure fetch | `src/core/bootstrap.ts`, `src/core/agent.ts` |
| UI | `src/ui/renderer.ts`, `src/cli/run-result.ts`, `src/cli/repl.ts`, `src/modules/webui/assets/js/feed/sidebar.ts`, `src/modules/webui/host-state.ts` |
| i18n | `src/i18n/en.json`, `src/i18n/ru.json` |
| Docs | `docs/agents/modules.md`, `AGENTS.md` (Cost Tracking), `CHANGELOG.md` |

### 10. Error handling & edge cases

- Network timeout / non-2xx / bad JSON → keep last snapshot (fail-open), log
  diagnostic; never throw into the turn.
- No cache and provider `none` → cost `undefined`; UI shows "price unavailable".
- `pricing.overrides` always win, including over reported cost? **No** — reported
  cost is the real charge for that call and wins for that call; overrides only
  feed the price table used when no reported cost exists.
- Mixed providers in one session → `costBreakdown` still attributes per provider;
  a provider with no source contributes no entry.
- Zero-token/aborted calls → no record.
- Offline → last snapshot; first-ever offline with `none` → no cost.

### 11. Testing

- `provider-price`: OpenRouter `/models` parse (per-token → per-1M, cache fields),
  validation rejects absurd/NaN/negative, TTL reuse, fail-open keeps snapshot.
- `openai-compat`: `usage:{include:true}` sent only when capability is `response`;
  `usage.cost` parsed in stream + non-stream; absent stays `undefined`.
- `CostTracker`: `recordReported` exact accumulation; `source` precedence;
  partial (mixed) sessions.
- `prices`: overrides-only resolution; no built-in table; unknown → `undefined`.
- UI: priced / free / unavailable states; never `$0.00` for unknown.
- `--json`: `totalCost` null when unknown; `costSource` present.
- Regression: remove/replace `tests/pricing.test.ts` builtin-table expectations.

### 12. Versioning & migration

- MINOR (2.19.0): new capability + behavior. `--json` contract unchanged
  (`totalCost: number | null` already existed; `costSource` is additive).
- Behavior change (documented in CHANGELOG `### Changed`): Zen/Go no longer show
  a built-in cost; users who relied on it set `pricing.overrides`.

## Open questions / assumptions

1. **Assumption:** OpenRouter returns `usage.cost` when `usage:{include:true}` is
   sent. Verify with a live call during implementation; if false, OpenRouter
   falls back to `/models` pricing only (still provider-native).
2. OpenRouter conditional pricing (`overrides`: peak/off-peak, long-context) is
   not modeled in v1; the top-level price is used. Acceptable because
   `response.cost`, when available, is exact.
3. Whether `pricing.autoFetch` / `cacheTtlHours` belong in the registry or stay
   internal — plan defaults to registry keys for discoverability.

## Review findings (must address before implementation)

Self-review against the code surfaced these; the spec is **not** ready to plan
until each is resolved and the affected sections rewritten.

### Critical

1. **Override vs. reported-cost precedence is contradictory.** Goals (§Goals),
   §2, §8 and §10 resolve it three different ways. Decide explicitly (proposal:
   reported cost > `pricing.overrides` > provider `/models`) and make every
   section agree.
2. **Partial totals silently mislead.** When only some calls are priced,
   `CostTracker.total` becomes a plain number shown as the session total — the
   exact "untrustworthy number" this feature exists to remove. Add an
   `partial`/`unpricedCalls` signal and reflect it in UI, `--json` and
   `session.jsonl` ("≥ $X, some calls unpriced").
3. **`resolvePrice(model, config)` cannot see the provider cache.** §4 says it
   consults the cached provider price, but the signature and the pure `prices.ts`
   module have no access to that state. Introduce a `PricingResolver` (injected
   snapshot) or extend the signature; specify it.
4. **Cache schema holds only one provider.** §5 stores a single `source`/
   `revision`/`models` per file, but sessions use multiple entries/providers and
   failover. Switch to `providers: Record<providerKey, Snapshot>` and define
   `providerKey` (e.g. `type|baseUrl`).
5. **"free" label lies for paid gateways.** §6 labels every `pricing.source:
   "none"` provider as "free", but `openai-compat` also covers paid self-hosted
   proxies. Label "free" only for genuinely local/no-billing providers
   (`lmstudio`); otherwise "price unavailable".

### Medium

6. **Zero cost is hidden by `> 0` gates.** `renderer.ts:561`, `run-result.ts:30`,
   `repl.ts:1152` render cost only when `> 0`, so a legitimately free
   provider-reported `usage.cost = 0` disappears. Gate on "known source", not
   `> 0`.
7. **REPL hides after-turn cost by default.** The whole REPL cost line sits under
   `ui.showContextStats` (default `false`, `repl.ts:1133`). Decide whether the
   cost line shows whenever a source is known, independent of context stats.
8. **`CostTracker.saved` / `cache_discount` undefined.** §3 records reported cost
   directly while `saved` is table-derived; interaction and double-count risk
   with `cache_discount` are unspecified. Define: `saved` only on the table path;
   never fold `cache_discount` into `saved`.
9. **Id collisions on merge.** §4/§5 normalizes ids to the last path segment, so
   `openai/gpt-4o` collides with any other `gpt-4o`. Key provider prices by the
   **exact** provider model id.
10. **Cache write is not concurrency-safe.** §5 does not specify atomic writes;
    `mma web` + REPL can corrupt `pricing-cache.json`. Use tmp+rename,
    best-effort.
11. **`autoFetch` / `pricing.enabled` / `source` scope unclear.** §8 does not
    define their interaction (does `autoFetch` gate response-cost parsing? does
    `pricing.enabled` disable everything?). Add a truth table.

### Minor / hygiene

12. **`modelsField` is speculative (YAGNI).** §1 adds it "for the future" with no
    consumer or test. Remove unless justified now.
13. **`revision` is stored but never used.** §5 — drop it or actually surface it
    in provenance.
14. **`CostTracker` "dominant source" is undefined.** §6 — with mixed sources,
    state the aggregation rule; prefer per-call source logging.
15. **Blast radius understated.** §11 lists only `tests/pricing.test.ts`, but
    builtin prices are also used by `tests/provider-cache-usage.test.ts`,
    `tests/cache-line.test.ts`, `tests/ui/renderer.test.ts`; and
    `docs/mma-features-overview.md` / `docs/agents/architecture.md` mention
    builtin MiniMax/GLM prices. Add them to Files.
16. **Bootstrap race.** §7 fetches in the background, so the first turn may be
    unpriced → partial (see #2). State that before the price snapshot is ready
    the provider path yields "unknown", never `$0`.

Decisions still open: #17 below (registry vs. internal) is a decision, not a
question — pick one when revising.

