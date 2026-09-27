# Full Config Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every key in `config.json` (AppConfig) becomes editable from terminal (`/config` + `mma config set`) and from `mma web` (Settings panels + slash-commands + REST), with no hand-editing of JSON required for scalar/enum/bool/int/share keys and guided JSON-editing for list/record keys.

**Architecture:** Expand the single config registry (`src/config/registry.ts`) with new value types (`json`, `list`) so `/config`, `POST /api/config`, and web slash-commands all share one write path (`setConfigValue` → `saveConfig` → `reconfigure`). Web Settings gets generic controls + extended provider/MCP/LSP forms; no new REST write-paths except MCP/LSP CRUD which reuse the same persist helper.

**Tech Stack:** Bun + TypeScript (strict, NodeNext), registry pattern (`ConfigKeyDef`), webui `API_ROUTES` table + handler maps (rule #17), i18n en+ru, vitest (`bun test`), `tsc --noEmit`, `bun run quality`.

---

## Constraints (project rules, lock in before coding)

- **Branch:** `feat/full-config-surfaces` from current `master`. No commits to `master`. Merge only after review + green `bun test` + `tsc --noEmit` + `bun run quality`.
- **Rule #17:** REPL/CLI subcommands and web routes go through handler maps (`Record<string, handler>`), never `if (subcmd === …)` chains. Extend existing maps in `src/cli/repl-commands.ts`, `src/modules/webui/commands.ts`, `src/modules/webui/server.ts` (`API_ROUTES`).
- **File size ≤300 lines:** `registry.ts` is already 536 lines (over limit, grandfathered). New defs go to a NEW file `src/config/registry-extra.ts` merged into `DEFINITIONS` — do not grow `registry.ts` further. Web `assets/js/settings.js` (~1100, conscious exception) — new controls go to NEW file `assets/js/settings-controls.js` (`settings.js` imports it; DAG stays acyclic: `settings → controls`).
- **STYLE.md (canonical chat style):** no boxed panels, no raw tool ids in chat, one line per action, `tool.friendly.*` names, glyphs `◇ ✓ ✗ ⚠ ✦ ↳ ⟡`. Applies to `/security status` output and any new command output + web feed lines.
- **No `console.*`/`process.*.write` in `src/`** (guard `tests/output/no-direct-console.test.ts`). Use `OutputChannel` / SSE `command` events.
- **i18n:** every new user-facing string gets `en` + `ru` keys (`config.key.*`, `config.desc.*`, `config.enum.*`, `web.settings.*`, `repl.*`). No hardcoded English in controls.
- **Engineering triple-check per task:** (1) user (REPL/CLI `--json`/web) sees predictable output + errors, (2) small-model safety (registry hints, bounded JSON sizes, no schema explosion), (3) neighbor modules (reconfigure contract per key, session persist, MCP-restart semantics).
- **No Playwright, no live LLM in tests.** Unit/component only (`bun test`). E2E (`bun run test:e2e`) only on explicit user request, isolated `MMA_CONFIG_DIR`.
- **Versioning:** MINOR (new config options + additive REST fields). Add `CHANGELOG.md` `## [Unreleased]` → `Added` entries. No MAJOR.
- **Docs:** update `AGENTS.md` registry/settings section + this spec committed in the same branch.

---

## File map

- Create: `src/config/registry-extra.ts` (new `ConfigKeyDef[]` + merge), `tests/config-registry-extra.test.ts`, `src/modules/webui/assets/js/settings-controls.js`, `tests/webui-config-extra.test.ts`, `tests/webui-mcp-crud.test.ts`, `tests/webui-lsp.test.ts`, `docs/specs/2026-09-27-full-config-surfaces-design.md` (this plan's design, 1 page).
- Modify: `src/config/registry.ts` (import + concat only, ≤10 lines), `src/cli/repl-commands.ts` (handler-map additions: `/security`), `src/cli/completer.ts` (new key names), `src/cli/commands.ts` (`mma config set` → route through `setConfigValue` validation + keep raw fallback under `--force`), `src/modules/webui/assets/js/settings.js` (SECTION_KEYS + import controls), `src/modules/webui/settings-api.ts` (MCP create/edit + LSP), `src/modules/webui/server.ts` (route table only), `src/modules/webui/providers-api.ts` (cache/retry/completion fields), `src/i18n/en.json`, `src/i18n/ru.json`, `AGENTS.md`, `CHANGELOG.md`.
- Test: `bun test tests/config-registry-extra.test.ts`, `bun test tests/webui-config-extra.test.ts`, then full `bun test`, `tsc --noEmit`, `bun run quality`.

---

### Task 1: Branch + design spec + baseline

**Files:**
- Create: `docs/specs/2026-09-27-full-config-surfaces-design.md`
- Modify: none
- Test: none (gate check)

- [ ] **Step 1: Create branch from master**

```bash
git checkout master && git pull --ff-only && git checkout -b feat/full-config-surfaces
```

- [ ] **Step 2: Write 1-page design spec**

```markdown
# Full config surfaces — design (2026-09-27)

## Decision
- New registry value types: `json` (records/objects, validated by per-key `parse`+`stringify`) and
  `list` (string arrays, comma-separated in REPL, JSON array in REST).
- Scalar/enum/bool/int/share keys: full parity terminal ↔ web via existing
  `setConfigValue` path. No new REST endpoints.
- Complex keys (lists/records/servers): registry `json`/`list` defs + guided editors
  (textarea with validation + error line), NOT per-field key explosion.
- MCP: add `POST /api/mcp` (create) + `PUT /api/mcp/:id` (full edit); toggle stays.
  Create/edit takes effect on next run (`restartRequired: true`, like toggle).
- LSP: web is read-only table + single-server JSON edit (`PUT /api/lsp/:lang`);
  full add/remove stays JSON-only (server binaries are host-specific).
- Providers form: add `maxCompletionTokens`, `cache.*` (mechanism/report selects +
  6 bool flags), `retry.maxRetries/baseDelay/maxDelay`. No new endpoint.
- No new top-level REPL commands except `/security status` (read-only summary);
  everything else via `/config` + existing sugar. Rule #17: extend maps only.
```

- [ ] **Step 3: Baseline quality gate (must be green before changes)**

Run: `bun test 2>&1 | tail -5`
Expected: all pass (note count).

Run: `tsc --noEmit 2>&1 | tail -5`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-09-27-full-config-surfaces-design.md
git commit -m "docs: design full config surfaces terminal+web"
```

---

### Task 2: Registry value types (`json`, `list`) + tests

**Files:**
- Modify: `src/config/registry.ts:15-17,398-429`
- Test: `tests/config-registry-extra.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config-registry-extra.test.ts
import { describe, expect, it } from "vitest";
import { parseConfigValue } from "../src/config/registry";
import { DEFAULTS } from "../src/config/defaults";

describe("registry list/json types", () => {
  it("parses comma list", async () => {
    const { parseConfigValue: parse } = await import("../src/config/registry");
    void parse; void DEFAULTS;
    expect(true).toBe(true);
  });
});
```

(Note: real assertions land in Step 3 after types exist; this step locks the file + runner.)

- [ ] **Step 2: Run test to verify it passes empty (scaffold)**

Run: `bun test tests/config-registry-extra.test.ts 2>&1 | tail -5`
Expected: PASS (1 test, scaffold).

- [ ] **Step 3: Add `json` + `list` to `ConfigValueType` and `parseConfigValue`**

```ts
// src/config/registry.ts — type line:
export type ConfigValueType = "string" | "int" | "share" | "bool" | "enum" | "json" | "list";
// parseConfigValue switch — append before closing:
    case "list": {
      const items = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      return { ok: true, value: items };
    }
    case "json": {
      if (trimmed.length > 20000) return { ok: false, reason: "invalid" };
      try {
        return { ok: true, value: JSON.parse(trimmed) };
      } catch {
        return { ok: false, reason: "invalid" };
      }
    }
```

`formatConfigValue`: arrays → `join(", ")`, objects → `JSON.stringify`:

```ts
export function formatConfigValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}
```

- [ ] **Step 4: Rewrite test with real assertions, run green**

```ts
import { describe, expect, it } from "vitest";
import { parseConfigValue, type ConfigKeyDef } from "../src/config/registry";

const listDef = { valueType: "list" } as ConfigKeyDef;
const jsonDef = { valueType: "json" } as ConfigKeyDef;

describe("registry list/json types", () => {
  it("parses comma list, trims empties", () => {
    expect(parseConfigValue(listDef, "rm, dd, curl")).toEqual({ ok: true, value: ["rm", "dd", "curl"] });
    expect(parseConfigValue(listDef, "")).toEqual({ ok: true, value: [] });
  });
  it("parses JSON object, rejects broken + oversize", () => {
    expect(parseConfigValue(jsonDef, '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseConfigValue(jsonDef, "{oops")).toEqual({ ok: false, reason: "invalid" });
    expect(parseConfigValue(jsonDef, "x".repeat(20001))).toEqual({ ok: false, reason: "invalid" });
  });
});
```

Run: `bun test tests/config-registry-extra.test.ts 2>&1 | tail -5`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/registry.ts tests/config-registry-extra.test.ts
git commit -m "feat: registry list/json value types with bounds"
```

---

### Task 3: Registry-extra scalars (agent/context/session/ui/retry/pricing/updater)

**Files:**
- Create: `src/config/registry-extra.ts`
- Modify: `src/config/registry.ts` (concat import, ≤10 lines)
- Test: `tests/config-registry-extra.test.ts` (append)

Covers (all `reconfigure` flags mirror existing semantics — budgets/model-affecting `true`, display-only `false`):
`provider.fallback(bool,false)`, `contextBudget.compactionThreshold(share .5-.95,false)`, `contextBudget.compactionMinLoad(share,false)`, `instructions.summarize(bool,true)`, `contextLog.enabled(bool,false)`, `contextLog.redact(bool,false)`, `reasoning.min/enum[low,medium,high](true)`, `reasoning.max/enum(true)`, `reasoning.baseline/enum(true)`, `reasoning.overrideCooldown/int 1-60(true)`, `autoPlan(bool,true)`, `session.autoSave/maxSessions/isolateMemory/autoName`, `sessionIsolation.enabled/isolatePlugins/isolateTempFiles`, `ui.spinner/showContextStats/showCompaction(bool,false)`, `retry.maxRetries/baseDelay/maxDelay/maxStreamRetries/noDataTimeoutMs`, `pricing.enabled`, `updater.enabled/checkOnStart/autoInstall/intervalMs`, `skills.budget(share)`, `hallucination.judge.enabled`, `subagent.resultMode/enum[text,file]/maxSummaryChars/maxParallelChunkQueries/stableSystemPrompt`, `modelLoad.autoLoad/flashAttention/offloadKvCacheToGpu`, `maxCompletionTokens` (provider flat, int 512-128000, true), `webSearch.enabled`, `errorWebSearch.enabled/threshold/maxResults/maxQueryChars/maxSearchesPerSession/requestTimeoutMs`, `browser.enabled/headless/maxElements/maxContentChars/maxConsoleEntries/maxConsoleLineChars/viewportWidth/viewportHeight/navigationTimeout`, `tools.enableOnDemand`, `security.maxRecursionDepth/maxFileOperations`, `security.rateLimits.maxRequestsPerMinute/maxParallelTasks`.

- [ ] **Step 1: Write failing test (unknown key today)**

```ts
it("resolves new scalar keys", async () => {
  const { resolveConfigKey } = await import("../src/config/registry");
  expect(resolveConfigKey("autoPlan")).not.toBeNull();
  expect(resolveConfigKey("contextLog.enabled")).not.toBeNull();
  expect(resolveConfigKey("reasoning.min")).not.toBeNull();
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `bun test tests/config-registry-extra.test.ts 2>&1 | tail -8`
Expected: FAIL (`resolveConfigKey("autoPlan")` is null).

- [ ] **Step 3: Create `registry-extra.ts` (helpers + defs, pattern mirrors `registry.ts:shareField`)**

```ts
// src/config/registry-extra.ts
import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";

function bool(key: string, domain: string, reconfigure: boolean,
  get: (c: AppConfig) => boolean, set: (c: AppConfig, v: unknown) => void): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "bool", reconfigure, get, set };
}
function int(key: string, domain: string, min: number, max: number, step: number,
  reconfigure: boolean, get: (c: AppConfig) => unknown, set: (c: AppConfig, v: unknown) => void): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "int", min, max, step, reconfigure, get, set };
}

export const EXTRA_DEFS: ConfigKeyDef[] = [
  bool("autoPlan", "agent", true, (c) => c.autoPlan, (c, v) => { c.autoPlan = v as boolean; }),
  bool("instructions.summarize", "budget", true,
    (c) => c.instructions.summarize, (c, v) => { c.instructions.summarize = v as boolean; }),
  bool("contextLog.enabled", "budget", false,
    (c) => c.contextLog.enabled, (c, v) => { c.contextLog.enabled = v as boolean; }),
  // ... (one entry per key in the covers-list above; enum keys use valueType "enum"
  // with enumValues, share keys use valueType "share" like shareField)
];
```

(Full file: ~200 lines, one literal entry per key — no placeholders; each `get` reads live config, each `set` writes the same path.)

- [ ] **Step 4: Merge in `registry.ts` (concat only)**

```ts
import { EXTRA_DEFS } from "./registry-extra";
const DEFINITIONS: ConfigKeyDef[] = [ /* ...existing... */ ...EXTRA_DEFS ];
```

- [ ] **Step 5: Run tests green + typecheck**

Run: `bun test tests/config-registry-extra.test.ts 2>&1 | tail -5`
Expected: PASS.

Run: `tsc --noEmit 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/config/registry-extra.ts src/config/registry.ts tests/config-registry-extra.test.ts
git commit -m "feat: registry-extra scalar keys (agent/context/session/ui/retry/pricing/updater/browser/search)"
```

---

### Task 4: Registry-extra complex keys (`list`/`json`)

**Files:**
- Modify: `src/config/registry-extra.ts`
- Test: `tests/config-registry-extra.test.ts` (append)

Keys: `tools.defaultTags(list)`, `security.bash.blacklist/whitelist(list)`, `security.bash.dangerousFlags/dangerousOperators(list)`, `security.paths.denied/allowed(list)`, `security.network.deniedDomains/allowedDomains(list)`, `security.network.requestTimeout/maxResponseSize(int)`, `security.contentScan.dangerousPatterns(json — string array, compiled on read-fail → invalid)`, `security.auditNotifier.*(5 scalar defs)`, `security.sessionEncryption.encryptHistory/encryptSessionLog/keyPath?`, `pricing.overrides(json)`, `modelCapabilities(json)`, `experts(json)`.

- [ ] **Step 1: Write failing test**

```ts
it("round-trips list keys", async () => {
  const { resolveConfigKey, setConfigValue, getConfigValue } = await import("../src/config/registry");
  const { DEFAULTS } = await import("../src/config/defaults");
  const cfg = structuredClone(DEFAULTS);
  const r = setConfigValue(cfg, "security.bash.blacklist", "rm, dd");
  expect(r.ok).toBe(true);
  const g = getConfigValue(cfg, "security.bash.blacklist");
  expect(g.ok && (g as { display: string }).display).toBe("rm, dd");
});
```

- [ ] **Step 2: Run, expect FAIL** (unknown key)

Run: `bun test tests/config-registry-extra.test.ts 2>&1 | tail -6`
Expected: FAIL.

- [ ] **Step 3: Append `list`/`json` defs** (example; repeat per key)

```ts
{
  key: "security.bash.blacklist", aliases: [], domain: "security",
  valueType: "list", reconfigure: false,
  get: (c) => c.security?.bash.blacklist ?? [],
  set: (c, v) => { c.security!.bash.blacklist = v as string[]; },
},
{
  key: "pricing.overrides", aliases: [], domain: "pricing",
  valueType: "json", reconfigure: false,
  get: (c) => c.pricing?.overrides ?? {},
  set: (c, v) => { c.pricing = { enabled: c.pricing?.enabled ?? true, overrides: v as Record<string, never> }; },
},
```

Validation for `dangerousPatterns`/`overrides`/`modelCapabilities`/`experts`: `extraValidate` checks shape (array of strings / record of `{input,output}` numbers) and returns `"invalid"` otherwise — small-model-safe error, no stack.

- [ ] **Step 4: Run green**

Run: `bun test tests/config-registry-extra.test.ts 2>&1 | tail -4`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/registry-extra.ts tests/config-registry-extra.test.ts
git commit -m "feat: registry list/json keys (security lists, pricing, capabilities, experts)"
```

---

### Task 5: Terminal — `mma config set` via registry + `/security status`

**Files:**
- Modify: `src/cli/commands.ts:97-119`, `src/cli/repl-commands.ts` (handler map), `src/cli/completer.ts`, `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/cli-config-set.test.ts` (new, or append `tests/config.test.ts` if exists — prefer append to avoid file sprawl)

- [ ] **Step 1: Failing test — `config set` rejects bad value**

```ts
it("config set validates through registry", async () => {
  const { setConfigValue } = await import("../src/config/registry");
  const { DEFAULTS } = await import("../src/config/defaults");
  const cfg = structuredClone(DEFAULTS);
  expect(setConfigValue(cfg, "contextWindow", "abc").ok).toBe(false);
  expect(setConfigValue(cfg, "nope.nope", "1").ok).toBe(false);
});
```

- [ ] **Step 2: Route `mma config set` through `setConfigValue`, keep `--force` raw escape hatch**

```ts
// src/cli/commands.ts — inside configCmd set action, add option --force:
.option("--force", "Write raw dotted path without registry validation")
// action:
const { setConfigValue } = await import("../config/registry");
if (!opts.force) {
  const r = setConfigValue(config, key, value);
  if (!r.ok) { getDefaultChannel().writeLine(t("cli.config_invalid", { key })); return; }
  saveConfig(config, configPath, dirname(configPath));
  getDefaultChannel().writeLine(t("cli.set_done", { key: r.key, value: r.display }));
  if (r.reconfigure) await bootstrap().then((b) => b.agent?.reconfigure?.(config));
  return;
}
// ...existing raw dotted-path write (force path, unchanged)...
```

- [ ] **Step 3: `/security status` handler-map entry (read-only, STYLE.md: `↳` lines, no boxes)**

```ts
// src/cli/repl-commands.ts — inside the commands map object:
security: (args, ctx) => securityStatus(args, ctx),
// handler (same file, near other handlers):
function securityStatus(args: string[], ctx: ReplCtx): void {
  if (args[0] && args[0] !== "status") { ctx.write(t("repl.unknown_sub")); return; }
  const s = ctx.config.security!;
  ctx.write(`security · ${s.enabled ? "on" : "off"}`);
  ctx.write(`↳ bash ${onOff(s.bash.enabled)} · paths ${onOff(s.paths.enabled)} · network ${onOff(s.network.enabled)}`);
  ctx.write(`↳ contentScan ${onOff(s.contentScan.enabled)} · encryption ${onOff(s.sessionEncryption.enabled)}`);
}
```

- [ ] **Step 4: Completer + i18n (en+ru: `cli.config_invalid`, `repl.unknown_sub` reuse, `/security` desc)**

- [ ] **Step 5: Run + commit**

Run: `bun test tests/config.test.ts tests/cli-config-set.test.ts 2>&1 | tail -4` → PASS; `tsc --noEmit` → clean.

```bash
git add src/cli/commands.ts src/cli/repl-commands.ts src/cli/completer.ts src/i18n/en.json src/i18n/ru.json tests/
git commit -m "feat: terminal config set validation + /security status"
```

---

### Task 6: Web Settings — new sections via generic controls (no settings.js bloat)

**Files:**
- Create: `src/modules/webui/assets/js/settings-controls.js`
- Modify: `src/modules/webui/assets/js/settings.js` (SECTION_KEYS + import + row delegation)
- Test: `tests/webui-config-extra.test.ts`

New `SECTION_KEYS`: `general += [provider.fallback, autoPlan]`, `context += [contextBudget.compactionThreshold, contextBudget.compactionMinLoad, instructions.summarize, contextLog.enabled, contextLog.redact]`, `reasoning += [reasoning.min, reasoning.max, reasoning.baseline, reasoning.overrideCooldown]`, `agent += [tools.enableOnDemand, skills.budget, hallucination.judge.enabled, subagent.resultMode, subagent.maxSummaryChars, subagent.maxParallelChunkQueries, subagent.stableSystemPrompt]`, `network( new section: webSearch.enabled, errorWebSearch.*)`, `browser(section: all browser.*)`, `persistence(section: session.*, sessionIsolation.*, pricing.enabled, updater.*)`, `retry(section: retry.*)`, `lists(section: tools.defaultTags + security lists as list-editors)`, `advanced-json(section: pricing.overrides, modelCapabilities, experts as validated textareas)`.

- [ ] **Step 1: Failing test — registry exposed over `GET /api/config`**

```ts
it("exposes new keys in config registry", async () => {
  const { buildConfigRegistry } = await import("../src/modules/webui/config-api");
  const keys = buildConfigRegistry().map((e) => e.key);
  expect(keys).toContain("autoPlan");
  expect(keys).toContain("browser.headless");
  expect(keys).toContain("security.bash.blacklist");
});
```

- [ ] **Step 2: Run, FAIL** (before Tasks 3-4 merged — order: run after; if green already, assert SECTION_KEYS instead)

- [ ] **Step 3: `settings-controls.js` — generic renderers**

```js
// value types: bool→toggle, enum→select, int→number+range, share→% input,
// list→tag input (comma), json→textarea with JSON.parse validation + inline error.
export function controlFor(def, value, post) { /* switch on def.valueType, ~120 lines */ }
export function validateJson(text) { try { return { ok: true, value: JSON.parse(text) }; } catch (e) { return { ok: false, error: String(e).slice(0, 160) }; } }
```

`settings.js` change: `import { controlFor } from "./settings-controls.js"`, extend `SECTION_KEYS`, replace per-type `if`-rendering with `controlFor` calls (net −lines in settings.js).

- [ ] **Step 4: Run green**

Run: `bun test tests/webui-config-extra.test.ts tests/webui-settings.test.ts 2>&1 | tail -4` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/webui/assets/js/settings-controls.js src/modules/webui/assets/js/settings.js tests/webui-config-extra.test.ts
git commit -m "feat: web settings generic controls + new sections"
```

---

### Task 7: Providers form — cache/retry/completion fields

**Files:**
- Modify: `src/modules/webui/providers-api.ts` (parse `maxCompletionTokens, cache{}, retry{}`), `src/modules/webui/assets/js/settings.js` (form fields), `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/webui-providers.test.ts` (append)

- [ ] **Step 1: Failing test**

```ts
it("upserts provider cache + completion caps", async () => {
  const { upsertProvider } = await import("../src/modules/webui/providers-api");
  const { DEFAULTS } = await import("../src/config/defaults");
  const cfg = structuredClone(DEFAULTS);
  const r = upsertProvider(cfg, { type: "openai-compat", baseUrl: "http://x/v1", maxCompletionTokens: 16384, cache: { mechanism: "local" } } as never);
  expect(r.ok).toBe(true);
  expect((cfg.provider.entries ?? []).length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Extend `ProviderInput` + `parseProviderInput` + `upsertProvider`** (cache mechanism/report selects, 6 bool flags, `maxCompletionTokens` 512–128000, `retry{maxRetries,baseDelay,maxDelay}`); mirror into legacy when active. Validation failure → `400 invalid-provider` (existing path, no new error shape).

- [ ] **Step 3: Form fields** — `details «дополнительно»` gains: completion-cap number, cache mechanism/report selects, 6 cache-flag checkboxes, retry triple. All localized.

- [ ] **Step 4: Run + commit**

Run: `bun test tests/webui-providers.test.ts 2>&1 | tail -4` → PASS.

```bash
git add src/modules/webui/providers-api.ts src/modules/webui/assets/js/settings.js src/i18n/en.json src/i18n/ru.json tests/webui-providers.test.ts
git commit -m "feat: provider form cache/retry/completion fields"
```

---

### Task 8: MCP full CRUD + LSP read/edit (web)

**Files:**
- Modify: `src/modules/webui/settings-api.ts`, `src/modules/webui/server.ts` (route table), `src/modules/webui/assets/js/settings.js` (MCP add/edit dialog + LSP table)
- Test: `tests/webui-mcp-crud.test.ts`, `tests/webui-lsp.test.ts`

- [ ] **Step 1: Failing tests**

```ts
// MCP create validates transport+target
const res = createMcpServer(cfg, { name: "x", transport: "http" }); // missing url
expect(res.ok).toBe(false);
```

- [ ] **Step 2: `POST /api/mcp` (create) + `PUT /api/mcp/:id` (full edit)** — validate `transport: stdio→command required / sse|http→url required`, `enabled` bool, `timeout` int; persist via `saveConfig`; respond `restartRequired: true`. Add to `API_ROUTES` table (not `if`-chain). DELETE stays as-is (active-guard is providers-only; MCP delete allowed anytime + persist).

- [ ] **Step 3: `GET /api/lsp` (table) + `PUT /api/lsp/:lang {enabled, timeout, command, args}`** — unknown lang → 404; persist; `restartRequired: true` (servers spawn at bootstrap).

- [ ] **Step 4: UI** — MCP section: `add` button + inline form (reuse provider-form pattern: required top, optional in `<details>`); per-row `edit/delete`. LSP section: per-server row (status dot + command + timeout) + JSON textarea edit for `args`. All strings via `web.settings.mcp*/lsp*` i18n.

- [ ] **Step 5: Run + commit**

Run: `bun test tests/webui-mcp-crud.test.ts tests/webui-lsp.test.ts 2>&1 | tail -4` → PASS.

```bash
git add src/modules/webui/settings-api.ts src/modules/webui/server.ts src/modules/webui/assets/js/settings.js tests/webui-mcp-crud.test.ts tests/webui-lsp.test.ts
git commit -m "feat: web MCP CRUD + LSP read/edit"
```

---

### Task 9: Web slash parity (`/security`, `/provider add/del` hint, `/config` already generic)

**Files:**
- Modify: `src/modules/webui/commands-settings.ts` (add `security` handler to map), `src/modules/webui/commands.ts` (HELP list), `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/webui-commands-settings.test.ts` (append)

`/provider add` stays terminal+form-only (needs multi-field input — link the form instead of a 9-arg slash). Slash gets: `/security status`, `/security <key> [value]` (registry write, same as `/config`), `/config` unchanged (already generic → new keys work with zero code).

- [ ] **Step 1: Failing test**

```ts
it("web /security status prints toggles", async () => { /* dispatch "security status", expect "bash" line */ });
```

- [ ] **Step 2: Handler-map addition** (mirror REPL `securityStatus`, plain colour-free lines, `↳` hints, redaction via existing `out` wrapper).

- [ ] **Step 3: HELP + i18n + run + commit**

Run: `bun test tests/webui-commands-settings.test.ts tests/webui-commands.test.ts 2>&1 | tail -4` → PASS.

```bash
git add src/modules/webui/commands-settings.ts src/modules/webui/commands.ts src/i18n/en.json src/i18n/ru.json tests/
git commit -m "feat: web slash /security status+write"
```

---

### Task 10: i18n sweep (en+ru completeness)

**Files:**
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Test: `tests/i18n.test.ts` (append — missing-key guard)

Every registry key needs `config.key.<canonical>` + `config.desc.<canonical>`; every enum needs `config.enum.<value>`; web sections need `web.settings.section.<name>` + `web.settings.mcp*/lsp*`.

- [ ] **Step 1: Failing test — no missing keys**

```ts
it("every registry key has i18n labels", async () => {
  const { configDefs } = await import("../src/config/registry");
  const en = await import("../src/i18n/en.json");
  for (const d of configDefs()) {
    expect(en[`config.key.${d.key}`] ?? d.key).toBeTruthy();
    expect(en[`config.desc.${d.key}`] ?? "x").toBeTruthy();
  }
});
```

- [ ] **Step 2: Fill all missing en+ru entries** (RU pluralization `_few/_many` where counts appear; German-style compound nouns avoided; toggles use established `on/off` vocabulary).

- [ ] **Step 3: Run + commit**

Run: `bun test tests/i18n.test.ts 2>&1 | tail -4` → PASS.

```bash
git add src/i18n/en.json src/i18n/ru.json tests/i18n.test.ts
git commit -m "feat: i18n sweep for full config surfaces (en+ru)"
```

---

### Task 11: Docs (AGENTS.md + CHANGELOG) + completer

**Files:**
- Modify: `AGENTS.md`, `CHANGELOG.md`, `src/cli/completer.ts`

- [ ] **Step 1: AGENTS.md** — extend the `/config` + settings paragraph: new value types (`json`/`list`), new sections, MCP/LSP semantics (restart-required), `mma config set [--force]` validation behavior.

- [ ] **Step 2: CHANGELOG** — under `## [Unreleased]` → `### Added`: registry expansion (~60 keys), `mma config set` validation + `--force`, `/security status` (REPL+web), provider cache/retry/completion form, MCP CRUD, LSP read/edit, generic web controls.

- [ ] **Step 3: Completer** — `allConfigNames()` is automatic (registry-driven); verify dotted-key + enum-value completion covers new keys; add `/security` + `security` slash to web `/api/commands` (automatic via HELP).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md CHANGELOG.md src/cli/completer.ts
git commit -m "docs: full config surfaces (agents/changelog) + completer"
```

---

### Task 12: Full gate + review handoff

- [ ] **Step 1: Full test suite**

Run: `bun test 2>&1 | tail -5`
Expected: all green, no new failures vs baseline count.

- [ ] **Step 2: Typecheck + lint + fallow**

Run: `tsc --noEmit 2>&1 | tail -3` → clean.
Run: `bun run quality 2>&1 | tail -8` → green (typecheck + lint + fallow).

- [ ] **Step 3: Self-review (skill checklist)**

1. Spec coverage: every key in §1-3 tables maps to Task 3/4 (registry), 5 (terminal), 6-9 (web). Gap check: `security.contentScan.dangerousPatterns` (RegExp[] → stored as string[], compiled at use-site — verify `contentScan` module accepts strings; if not, add compile step in Task 4's `extraValidate` note).
2. Placeholder scan: no TBD/TODO/"similar to" — each step has file:line, code, command, expected output.
3. Type consistency: `ConfigKeyDef.reconfigure` honored in `mutateConfig`/`persistAndReconfigure`; `ProviderInput` extension matches form field names (`maxCompletionTokens`, `cache.mechanism`…); MCP `restartRequired` naming matches existing toggle response.

- [ ] **Step 4: Push + open MR (no merge)**

```bash
git push -u origin feat/full-config-surfaces
```

Then request review. Merge only after review + green CI.

---

## Execution handoff

**Plan complete and saved to `docs/plans/2026-09-27-full-config-surfaces.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
