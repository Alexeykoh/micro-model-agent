# Dynamic Reasoning Control — Implementation Plan

> **Spec:** `docs/specs/2026-08-25-dynamic-reasoning-control.ru.md`
> **Based on:** codebase exploration 2026-08-25

## Step 1: Types + Config

**Files:**
- `src/config/types.ts` — add `ReasoningConfig` interface + field on `AppConfig`
- `src/config/defaults.ts` — add defaults

**What:**
```typescript
// src/config/types.ts
export type ReasoningLevel = "default" | "none" | "low" | "high" | "max";
export type ReasoningMode = ReasoningLevel | "auto";

export interface ReasoningConfig {
  mode: ReasoningMode;           // default: "auto"
  min: Exclude<ReasoningLevel, "default" | "auto">;  // default: "low"
  max: Exclude<ReasoningLevel, "default" | "auto">;  // default: "high"
  overrideCooldown: number;      // default: 5
}
```

Add to `AppConfig`:
```typescript
reasoning?: ReasoningConfig;  // optional, merged from defaults
```

**Defaults in `defaults.ts`:**
```typescript
reasoning: { mode: "auto", min: "low", max: "high", overrideCooldown: 5 }
```

**Tests:** `tests/config.test.ts` — defaults merge, validation (mode ∈ enum, min/max ∈ levels).

---

## Step 2: ProviderCapabilities strategy enum

**Files:**
- `src/modules/providers/types.ts` — change `reasoningEffort: boolean` → `reasoningStrategy: ReasoningStrategy`
- `src/modules/providers/presets.ts` — update all presets

**What:**
```typescript
export type ReasoningStrategy = "openai-effort" | "template-kwarg" | "prompt-tag" | "none";

export interface ProviderCapabilities {
  // ...
  reasoningStrategy: ReasoningStrategy;  // was reasoningEffort: boolean
}
```

Presets mapping:
| Preset | `reasoningStrategy` |
|---|---|
| `openai` | `"openai-effort"` |
| `openrouter` | `"openai-effort"` |
| `opencode-zen` | `"openai-effort"` |
| `opencode-go` | `"openai-effort"` |
| `openai-compat` | `"none"` (default until probe confirms) |
| `anthropic` | `"none"` |

**Update all usages** of `.reasoningEffort` (boolean checks) → `.reasoningStrategy !== "none"`.

**Tests:** `tests/providers.test.ts` — strategy values per preset.

---

## Step 3: EffortMechanism — apply strategy in buildRequestBody

**Files:**
- `src/llm/openai-compat.ts` — extend `buildRequestBody` to accept strategy + level
- `src/llm/provider.ts` — extend `ChatOptions` to include strategy

**What:**

`ChatOptions` gains:
```typescript
reasoningStrategy?: ReasoningStrategy;  // from provider capabilities
```

`buildRequestBody` logic per strategy:
```
if strategy === "openai-effort":
  if level !== "default": body.reasoning_effort = level
elif strategy === "template-kwarg":
  body.chat_template_kwargs = { enable_thinking: level !== "none" }
elif strategy === "prompt-tag":
  if level === "none":
    append "/no_think" to last user message (outgoing copy only)
```

**Tests:** `tests/openai-compat.test.ts` — each strategy × each level.

---

## Step 4: Startup probe

**Files:**
- New: `src/modules/reasoning/probe.ts`
- `src/core/bootstrap.ts` — fire probe at startup

**What:**
```typescript
export async function probeReasoningSupport(
  provider: LLMProvider,
  strategy: ReasoningStrategy,
  signal?: AbortSignal
): Promise<boolean>  // true = mechanism works
```

Logic:
1. If `strategy === "none"` → return false (no probe needed).
2. Send a trivial non-streaming request with level forced to `"none"` via the mapped mechanism.
3. Check response: if `reasoning_content` present → mechanism ignored → return false.
4. Cache result in a `Map<string, boolean>` keyed by `baseUrl|model`.
5. On failure → return false.

Bootstrap integration:
- Fire as background promise (like LSP probe).
- Result consumed by agent loop before first LLM call (lazy prompt block or ready flag).
- Failure → `[WARN] reasoning.probe_failed` + mode fallback to `"default"`.

**Tests:** `tests/reasoning-probe.test.ts` — mechanism detected/not-detected, caching.

---

## Step 5: ReasoningPolicy

**Files:**
- New: `src/modules/reasoning/policy.ts`
- `src/core/agent.ts` — wire policy before LLM call

**What:**

```typescript
export interface PolicyInput {
  hallucinationRetry: boolean;     // was this iteration triggered by hallucination retry
  auditRejection: boolean;         // was this iteration triggered by audit gate rejection
  recoverableLlmError: boolean;    // was this iteration triggered by recoverable LLM error
  planCreated: boolean;            // was plan created/re-planned this iteration
  consecutiveSuccesses: number;    // consecutive successful file-mutating calls on current step
  isRepetitive: boolean;           // stuck detector: repetitive tool calls
  baseline: ReasoningLevel;        // from config (default level)
}

export interface PolicyResult {
  level: ReasoningLevel;
  reason: string;  // for logging: "policy:hallucination-retry", "policy:routine-write", etc.
}
```

Pure function: `evaluateReasoningPolicy(input: PolicyInput): PolicyResult`

Agent loop integration (`agent.ts` ~line 589):
```typescript
const policyResult = this.effectiveReasoningMode === "auto"
  ? evaluateReasoningPolicy({ ... })
  : null;

const effortLevel = policyResult?.level ?? this.effectiveReasoningLevel;

// pass to chat:
for await (const chunk of llmProvider.chat(
  history, allTools, signal,
  { reasoningEffort: effortLevel, reasoningStrategy: this.reasoningStrategy }
)) { ... }
```

**Decay logic:** track `iterationsSinceLastRaise` counter; reset to 0 on any raise; when ≥5, level returns to baseline. Implemented inside the policy state object (not in agent.ts).

**Tests:** `tests/reasoning-policy.test.ts` — signal table, raise-wins, decay.

---

## Step 6: `set_thinking` tool

**Files:**
- New: `src/tools/set-thinking.ts`
- `src/tools/index.ts` — conditional registration

**What:**

```typescript
// src/tools/set-thinking.ts
export function createSetThinkingTool(
  getState: () => ReasoningState,
  setState: (level: ReasoningLevel) => void,
  config: ReasoningConfig
): ToolDefinition {
  return {
    name: "set_thinking",
    description: "Set reasoning effort level. Normally managed automatically by the harness. Use only to force deeper thinking for genuinely hard subproblems.",
    icon: "🧠",
    tags: [],
    alwaysOn: true,
    parameters: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["none", "low", "high", "max"] },
        reason: { type: "string", description: "Why changing level" },
      },
      required: ["level"],
    },
    handler: async (ctx, args) => { ... },
  };
}
```

Handler logic:
- Read current state + cooldown counter.
- If within cooldown → return deferred message (no error).
- Clamp level to `[config.min, config.max]`.
- Set shared state (like `activeToolTags` pattern).
- Return effective level + mode.

Registration in `src/tools/index.ts`:
- Only when `config.reasoning.mode === "auto"` AND probe succeeded.
- Gate on `reasoningStrategy !== "none"`.

**State sharing:** Add `reasoningLevel` and `reasoningOverrideIteration` to `ToolContext` (or use a shared object reference like `activeToolTags`).

**Tests:** `tests/tools/set-thinking.test.ts` — clamp, cooldown, alwaysOn.

---

## Step 7: REPL `/reasoning` command

**Files:**
- `src/cli/repl-commands.ts` — extend existing command
- `src/cli/repl.ts` — add `setReasoning()` method on Agent or config

**What:**

Current `/reasoning` (line 249-258) toggles `config.showReasoning`. Extend:

```typescript
action: (args?: string) => {
  if (!args || args === "") {
    // show current: "Reasoning: auto (active)" or "Reasoning: high (manual)"
    const mode = config.reasoning?.mode ?? "auto";
    const current = agent.getCurrentReasoningLevel?.() ?? "N/A";
    console.log(`Reasoning: ${current} (${mode})`);
    return;
  }
  const valid: ReasoningMode[] = ["auto", "default", "none", "low", "high", "max"];
  if (!valid.includes(args as ReasoningMode)) { ... error ... }
  agent.setReasoningMode(args as ReasoningMode);
  console.log(`Reasoning mode: ${args}`);
}
```

Also update `/status` to show current reasoning level.

**i18n keys:** `repl.reasoning_show`, `repl.reasoning_set`, `repl.reasoning_invalid` (en+ru).

**Tests:** `tests/cli/repl-reasoning.test.ts` — show/set/invalid.

---

## Step 8: CLI `--reasoning` flag

**Files:**
- `src/cli/commands.ts` — add `.option("--reasoning <level>")` to main command
- `src/cli/main.ts` — read flag, pass to agent deps

**What:**

In `createProgram()`:
```typescript
.option("--reasoning <level>", "Set reasoning effort: auto|default|none|low|high|max")
```

In `main.ts` one-shot path:
```typescript
if (opts.reasoning) {
  config.reasoning = { ...config.reasoning, mode: opts.reasoning };
}
```

In REPL startup:
```typescript
if (opts.reasoning) {
  agent.setReasoningMode(opts.reasoning);
}
```

**Tests:** `tests/cli/main.test.ts` — flag parsing.

---

## Step 9: Observability

**Files:**
- `src/core/session-logger.ts` — add `logReasoningControl()`
- `src/modules/context/fact-extractor.ts` — add `reasoningFacts` + `reasoningLine()`
- `src/i18n/en.json` + `src/i18n/ru.json` — new keys

**What:**

Session logger:
```typescript
logReasoningControl(from: ReasoningLevel, to: ReasoningLevel, reason: string, iteration: number) {
  this.appendLog({ ts: Date.now(), type: "reasoning_control", from, to, reason, iteration });
}
```

FactExtractor:
```typescript
private reasoningFacts: { level: ReasoningLevel; iteration: number }[] = [];

recordReasoningChange(level: ReasoningLevel, iteration: number) {
  this.reasoningFacts = [{ level, iteration }];  // keep only latest
}

reasoningLine(): string | null {
  if (!this.reasoningFacts.length) return null;
  const latest = this.reasoningFacts[this.reasoningFacts.length - 1];
  return `[Thinking: ${latest.level}]`;
}
```

i18n keys:
- `reasoning.probe_failed` (en+ru)
- `reasoning.mode_set` (en+ru)
- `reasoning.cooldown` (en+ru)
- `tool.friendly.set_thinking` (en+ru)
- `tool.thinking_set` (en+ru)
- `repl.reasoning_show` / `repl.reasoning_set` / `repl.reasoning_invalid` (en+ru)

**Tests:** session-log event type, fact extractor reasoning line.

---

## Step 10: Certification integration

**Files:**
- `src/modules/certification/scenarios.ts` — extend `PROVIDER_BASE`
- `src/modules/certification/types.ts` — (no change needed, `config` is generic)
- `src/modules/certification/cli.ts` — no change (config injection already works)

**What:**

Extend `PROVIDER_BASE` to include reasoning config:
```typescript
const PROVIDER_BASE = {
  provider: { maxCompletionTokens: 16384 },
  reasoning: { mode: "none" },  // certify with thinking OFF by default
};
```

Scenarios that benefit from thinking can override:
```typescript
{
  id: "3.5",
  config: { reasoning: { mode: "auto" } },  // test auto mode
}
```

Per-scenario `config` already deep-merges via `deepMergeAny()` — no runner changes needed. The spawned agent reads `MMA_CONFIG_DIR/.mma/config.json` which includes the merged reasoning config.

Add a new cert tag `"reasoning"` for scenarios that specifically test reasoning control behavior.

**Tests:** `tests/cert-scenarios.test.ts` — PROVIDER_BASE includes reasoning, scenario override merges correctly.

---

## Step 11: Docs

**Files:**
- `AGENTS.md` — add reasoning control section (config + REPL + CLI + tool)
- `README.md` — add `--reasoning` to usage examples
- `docs/small-model-observations.md` — add entry after first live validation

---

## Dependency order

```
Step 1 (types) ──→ Step 2 (capabilities) ──→ Step 3 (mechanism)
                         ↓
                    Step 4 (probe)
                         ↓
              Step 5 (policy) + Step 6 (tool)  ← parallel
                         ↓
         Step 7 (REPL) + Step 8 (CLI) + Step 9 (obs) ← parallel
                         ↓
              Step 10 (cert) + Step 11 (docs)
```

Steps 1-4 are sequential (each depends on the previous). Steps 5-6 can be parallel. Steps 7-9 can be parallel. Steps 10-11 are last.

## Estimated scope

- ~6 new files (types already exist in some, new: `probe.ts`, `policy.ts`, `set-thinking.ts`)
- ~8 modified files
- ~12 new test files/cases
- No breaking changes
- **MINOR bump** (new tool + new config section + REPL command extension)
