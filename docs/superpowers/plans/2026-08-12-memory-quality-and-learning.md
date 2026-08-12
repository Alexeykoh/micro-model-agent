# Memory Quality Gate + Self-Learning — Unified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independent upgrades to make persistent memory trustworthy and self-improving:

1. **Memory quality gate** — prevent garbage, duplicates, and low-quality entries from polluting persistent memory (`conventions.md`, `decisions.md`, `errors.md`, `facts.md`). Kills the self-reinforcing memory-corruption loop ("Agent Memory Broke"): for a 9B model, garbage written to memory becomes future prompt input → progressive corruption. Deterministic validation at *save time*, not generation time.
2. **Self-learning** — turn successful sessions into reusable `SKILL.md` files via `mma learn` CLI (nudge) + an in-session auto-suggestion directive, with a strict 1-LLM-call budget and deterministic validation.

**Merged from:** `2026-08-11-memory-quality-gate.md` + `2026-08-11-self-learning.md` (both superseded, removed) + the still-useful `detectLanguage` idea from `2026-08-04-language-support-verifier.md` (folded into Task 14, optional).

**Already implemented — do NOT re-do:**

- `SessionStore.loadSessionLog()` exists (`src/modules/session/store.ts:212`). Task 10 only adds a thin `SessionManager` delegate.
- `Auditor.runTests()` (R4, v0.28.15) already runs language-agnostic test checks (`findTestFile` + `bun test`). Task 14 must not duplicate that; it only adds syntax adapters to the *Verifier*.
- `agent.ts:689` already constructs `MemoryStore` and calls `appendRule` — Task 5 only wires the returned `ValidationResult`.

**Tech Stack:** TypeScript strict, vitest (`bun test`), `tsc --noEmit`. i18n rule #8 (en+ru parity) for every new user-facing string.

---

## Phase A — Memory Quality Gate

### Task 1: MemoryValidator (core validation logic)

**Files:** Create `src/modules/memory/validator.ts`; create `tests/modules/memory/validator.test.ts`.

- [ ] Write failing tests first (module not found), then implement, then commit (`feat(memory): add MemoryValidator with garbage/duplicate/length checks`).

Rules (all deterministic):

- **Garbage patterns** (reject): single `-`; `[x] ...` checkbox fragment; markdown heading `#...`; bold heading like `**Summary**`; bare brackets; just a number; single letter (en/ru).
- **Length**: `< minChars` (default 15) reject; `< minWords` meaningful words (default 3, words with length > 2, stop words excluded) reject.
- **Category rules**: `preferences` must be `key=value` (bypasses length); `errors` entries need > 20 chars; `facts` need enough meaningful words (not just a label).
- **Duplicates**: exact match reject; near-duplicate via Jaccard on content tokens (stop words stripped, `STOP_WORDS` set incl. Russian `и в не на я что с он а то все она так его но да ты к у же вы за бы по от мы как мне это уже`) with threshold 0.8.
- **Bilingual**: Russian entries validated by the same char/word thresholds.
- **`validateRule(category, pattern, cause, solution)`** — field-level checks (each field ≥ 5 chars, garbage patterns), then full-entry duplicate check. Used by `appendRule`.

Key signatures:

```ts
export interface ValidationResult { accepted: boolean; reason?: string }
export class MemoryValidator {
  constructor(memoryDir: string, opts?: { minChars?: number; minWords?: number; similarityThreshold?: number })
  validate(category: string, entry: string): ValidationResult
  validateRule(category: string, pattern: string, cause: string, solution: string): ValidationResult
}
```

Existing entries are read from `<memoryDir>/<category>.md` lines starting with `-`, timestamp prefix (`- **YYYY-MM-DD HH:MM:SS** —`) stripped, `**pattern:**/**cause:**/**solution:**` labels stripped before comparison.

### Task 2: Integrate validator into MemoryStore

**Files:** Modify `src/modules/memory/store.ts`; create `tests/modules/memory/store-gate.test.ts`.

- [ ] `append(category, entry)` and `appendRule(...)` return `ValidationResult`; write only when `accepted`. Keep `ensureDir`/init behavior. Add a `validationEnabled` flag (constructor opt, default true) so validation can be skipped.
- [ ] Tests: garbage entry rejected AND not written to file; valid entry written; duplicate rejected; `appendRule` garbage pattern rejected. Commit (`feat(memory): integrate MemoryValidator into store write path`).

### Task 3: Surface validation warnings in the remember tool

**Files:** Modify `src/tools/remember.ts`; modify `src/i18n/en.json` + `src/i18n/ru.json`.

> **Facts from the code:** `remember.ts` uses `new MemoryStore(join(homedir(), '.mma', 'memory'))` (global memory dir, not project). i18n keys are FLAT dot-separated strings (`'tool.remember.entry'` is a single top-level key in en.json, not a nested object) — add `tool.remember.rejected` as a flat sibling.

- [ ] i18n key `tool.remember.rejected` (flat, next to `tool.remember.entry`): en `"Entry rejected: {reason}. Rephrase with a concrete, actionable description."` / ru `"Запись отклонена: {reason}. Переформулируйте конкретно и по делу."`
- [ ] Handler: construct the store with the validator config from context — `const store = new MemoryStore(memoryDir, ctx.config.memory?.validator)` — then `const result = store.append(category, entry); if (!result.accepted) return { success: false, output: t("tool.remember.rejected", { reason: result.reason }) };` Success path unchanged (`tool.remember.entry`).
- [ ] `tsc --noEmit` + `bun test tests/modules/memory/` green. Commit (`feat(memory): surface validation warnings in remember tool output`).

### Task 4: Config wiring

**Files:** Modify `src/config/types.ts`, `src/config/defaults.ts`, `src/modules/memory/module.ts`, `src/core/bootstrap.ts` (line ~303).

- [ ] `AppConfig.memory?: { validator?: { enabled?: boolean; minChars?: number; minWords?: number; similarityThreshold?: number } }`; defaults `{ enabled: true, minChars: 15, minWords: 3, similarityThreshold: 0.8 }` (insert `memory:` in `DEFAULTS` next to `lsp: DEFAULT_LSP_CONFIG`, `src/config/defaults.ts:101`).
- [ ] `MemoryStore` constructor becomes `(memoryDir: string, validatorOpts?: { enabled?: boolean; minChars?: number; minWords?: number })` — existing call sites that ignore the return value (`agent.ts:690`, `remember.ts:63`, `MemoryModule.getStore()`) stay type-valid (void → ValidationResult is assignable-ignored).
- [ ] `MemoryModule` constructor becomes `(memoryDir?: string, validatorOpts?: ...)` and `bootstrap.ts` passes the config: `new MemoryModule(join(dir, "memory"), config.memory?.validator)`. Commit (`feat(memory): configurable validator thresholds`).

### Task 5: Handle validation result in agent loop

**Files:** Modify `src/core/agent.ts` (line ~689).

- [ ] The existing `appendRule` call now returns `ValidationResult`; construct the store with config — `new MemoryStore(memDir, config.memory?.validator)` — and on `!accepted` just `logger.debug(...)` (never crash the loop). Commit (`fix(memory): handle validation result from appendRule in agent loop`).

### Task 6: Small Model Engineering Principles in AGENTS.md

**Files:** Modify `AGENTS.md` (after "Key Design Rules").

- [ ] Add `## Small Model Engineering Principles` with the 4 principles: context is a finite resource; generation-time constraints consume capacity (no grammar/schema forcing); control at save time, not generation time (hallucination pipeline, stuck detector, final audit, memory quality gate); one task per call (6-layer state machine). Plus the "Self-reinforcing memory corruption" note pointing at `src/modules/memory/validator.ts`. Commit (`docs: small model engineering principles`).

---

## Phase B — Self-Learning (Phase 1: Skills)

> **Spec:** `docs/specs/2026-08-11-self-learning-design.md` (Phase 2 — gated error learning — design-only, NOT implemented).

### Task 7: Learning types + TraceReader

**Files:** Create `src/modules/learning/types.ts`, `src/modules/learning/trace.ts`; create `tests/learning-types.test.ts`, `tests/learning-trace.test.ts`.

- [ ] Types: `TraceStep { tool, action, status: "ok"|"error", error? }`, `TraceSummary { sessionId, toolCallCount, steps, errors }`, `SkillDraft { name, content }`, `ValidationResult { ok, errors, warnings }`.
- [ ] `TraceReader` — deterministic compaction of `session.jsonl`, **no LLM**:
  - Constructor takes a narrow interface `SessionLogSource { loadSessionLog(id): SessionLogEntry[] }` (both `SessionStore` and `SessionManager` satisfy it — no casts).
  - Compacts each `tool_call` to `tool + compacted args` (first 3 args, values truncated to 80 chars); `tool_result` with `success:false` marks the step `error` and records the FIRST LINE of the error (≤ 200 chars); raw content NEVER leaks into the summary.
  - Returns `null` when the log is empty or `toolCallCount === 0`.
- [ ] Tests: compaction + no-raw-content-leak assertions; null cases. Commit (`feat(learning): add TraceReader deterministic compaction`).

### Task 8: SkillValidator + SkillGenerator

**Files:** Create `src/modules/learning/validator.ts`, `src/modules/learning/generator.ts`; create `tests/learning-validator.test.ts`, `tests/learning-generator.test.ts`.

- [ ] `SkillValidator(existingNames, { minLength, maxLength })` — name regex `^[a-z0-9][a-z0-9-]{0,39}$`; duplicate name reject; frontmatter must parse (`---` block, `name`/`description`/`when_to_use`); description ≥ 10 chars; body length within `[minLength, maxLength]` (default 200–3000); garbage bodies (heading-only, checkbox fragment, single word) reject; `when_to_use` missing → warning only.
- [ ] `SkillGenerator({ model, baseUrl, apiKey, contextWindow }, provider)` — ONE `provider.chat()` call with a fixed system prompt (extract reusable procedure: when-to-use, numbered steps, "What to avoid"; output ONLY valid SKILL.md with YAML frontmatter incl. `mma_version: 2`; ≤ 3000 chars). Strips a single fenced ``` block if present; derives slug name from frontmatter `name` or `slugify()` fallback; throws `no text` when provider returns empty.
- [ ] Tests: valid fenced draft; slug fallback; empty-provider throws; validator accept/reject matrix. Commit (`feat(learning): SkillValidator + SkillGenerator`).

### Task 9: Config + LearningModule + bootstrap

**Files:** Modify `src/config/types.ts`, `src/config/defaults.ts`; create `src/modules/learning/module.ts`; modify `src/core/bootstrap.ts`; create `tests/learning-module.test.ts`.

- [ ] `LearningConfig { enabled: boolean; skillGeneration: { minToolCalls: number; minLength: number; maxLength: number; targetDir: "project"|"global" }; nudge: { enabled: boolean } }`; `DEFAULT_LEARNING_CONFIG` `{ enabled: false, minToolCalls: 3, minLength: 200, maxLength: 3000, targetDir: "project", nudge: { enabled: true } }`; field `learning?: LearningConfig` on `AppConfig`.
- [ ] `LearningModule implements AgentModule` — `getSystemPromptBlock()` returns a `low`-priority block with the directive (`...suggest saving it as a skill in your final answer... Do NOT create files or call save tools — the user runs \`mma learn\`...`) when`enabled && nudge.enabled`, else`null`.
- [ ] Register in `bootstrap.ts` right after `moduleRegistry.register(memoryModule)` (line ~304):

```ts
import { LearningModule } from "../modules/learning/module";
// ...
if (config.learning?.enabled) {
  moduleRegistry.register(new LearningModule(config.learning));
}
```

Tests: block content/priority; null when disabled. Commit (`feat(learning): LearningModule directive + bootstrap`).

### Task 10: SessionManager.loadSessionLog delegate

**Files:** Modify `src/modules/session/manager.ts`; create `tests/learning-session-delegate.test.ts`.

- [ ] Public method `loadSessionLog(id: string): SessionLogEntry[] { return this.store.loadSessionLog(id); }` (store method already exists — this is a thin delegate so `TraceReader` can be wired without casts). Test with a temp store + manager — note the manager's real API is `SessionManager.create(name?, securityOverrides?): SessionMeta` (there is NO `createSession`), and `SessionManagerOptions` requires `{ model, contextWindow, projectDir }`:

```ts
const store = new SessionStore(join(dir, "sessions"));
store.init();
const mgr = new SessionManager(store, { model: "m", contextWindow: 32768, projectDir: dir });
const id = mgr.create("t").id;
store.appendSessionLog(id, { ts: "1", type: "user", content: "hi" });
expect(mgr.loadSessionLog(id)).toHaveLength(1);
```

Commit (`feat(learning): SessionManager.loadSessionLog delegate`).

### Task 11: `mma learn` CLI command

**Files:** Create `src/modules/learning/cli.ts`, `src/modules/learning/index.ts`; modify `src/cli/commands.ts`; create `tests/learning-cli.test.ts`.

- [ ] Testable core `runLearn(deps)` where `LearnDeps { config, getSummary(): TraceSummary|null, generate, confirm, save }` owns the whole flow: `no-session` when summary null → `nothing-to-learn` when `toolCallCount < minToolCalls` → `generate` → `confirm` → validate (`SkillValidator` with empty existing list) → `invalid` on failure → `save` → `saved`; `declined` on reject.
- [ ] Production wrapper `runLearnCli({ config, sessionManager, baseDir, sessionId?, global?, prompt? })`: resolve session (default newest via `manager.list()`), `TraceReader` via the `SessionLogSource` interface, `SkillGenerator` over a real `OpenAICompatProvider` built from config, `askConfirm` (injectable `prompt` fn for tests; falls back to `readline`), `save` writes to `<project>/.mma/skills/` (or `~/.agents/skills` with `--global` or `targetDir: "global"`) after a duplicate-name check via `SkillsLoader.loadFromAllSources(builtinDir, globalDir, projectDir)`.
  - **Dirs must mirror `bootstrap.ts:184-186`:** `builtinDir = join(import.meta.dirname, "..", "skills", "builtin")` (from `src/modules/learning/cli.ts` this resolves to `src/modules/skills/builtin` — exists in dev; the raw `dist/` copy is handled by `copy-assets`), `globalDir = join(homedir(), ".agents", "skills")`, `projectDir = join(baseDir, ".mma", "skills")`. `SkillMeta` is the loader's return type.
- [ ] `index.ts` public exports. `commands.ts`: `mma learn` subcommand (`--session <id>`, `--global`) following the `model certify` dynamic-import pattern (`commands.ts:187`); the action receives `const { config, sessionManager, baseDir } = await bootstrap()` (all three are fields of `BootstrapResult`, `bootstrap.ts:89`); outcome → i18n message, `process.exitCode = 1` for `invalid`/`no-session`.
- [ ] Tests: all four flow decisions with injected fakes (never a real provider). Commit (`feat(learning): mma learn CLI command`).

### Task 12: i18n strings

**Files:** Modify `src/i18n/en.json`, `src/i18n/ru.json`.

> **Format fact:** en.json/ru.json are FLAT — keys are dot-separated top-level strings (e.g. `"cli.certify"`, `"tool.remember.entry"`), there is no nested `cli: {...}` object. Add `cli.learn`, `cli.learn_session`, `cli.learn_global`, `cli.learn_saved`, `cli.learn_declined`, `cli.learn_invalid`, `cli.learn_nothing`, `cli.learn_no_session` as flat siblings of the existing `cli.*` keys.

- [ ] Add all 8 keys (en + ru, parity). Verify parity with the flat-key python script, then `tsc --noEmit`. Commit (`feat(learning): i18n strings`).

### Task 13: AGENTS.md + integration verification

**Files:** Modify `AGENTS.md`; create `_testing/learning/README.md` (manual notes, gitignored).

- [ ] `## Self-Learning` section (concise ~15 lines): spec link, `mma learn` flow, auto-suggestion directive, 1-LLM-call budget, `minToolCalls` skip, source files.
- [ ] Smoke: run a multi-step sandbox task (`_testing/learning/`), then `bun run mma learn --session <id>`, record draft quality/name/validation in `_testing/learning/README.md`.
- [ ] Full verification: `bun test && tsc --noEmit` green. Commit (`docs: document self-learning module`).

---

## Phase C — Optional: Language adapters for the Verifier

**Files:** Create `src/modules/execution/language-adapters.ts`; create `tests/language-adapters.test.ts`; modify `src/modules/execution/verifier.ts`.

> Folded in from `2026-08-04-language-support-verifier.md`. Do NOT touch `Auditor.runTests` (R4 already language-agnostic).

- [ ] `LanguageAdapter` interface (`validateSyntax(file): Promise<boolean>`) + `detectLanguage(dir)` (priority: `tsconfig.json` → TS, `pyproject.toml`/`requirements.txt` → Python, `go.mod` → Go, `Cargo.toml` → Rust, fallback TS). Adapters: TS `tsc --noEmit --skipLibCheck` per file, Python `python -m py_compile`, Go `go vet` (file-level syntax via `gofmt -e`), Rust `rustc --crate-type lib --emit=metadata` (or `cargo check`).
- [ ] Replace the hardcoded JS/TS branch in `Verifier.validateSyntax` (`verifier.ts:144`) with the detected adapter — **keep the existing graceful-degradation contract** (missing toolchain / `ENOENT` / status 127 → treat as pass, i.e. return `true` for TS as today; unknown ext → `true`). Add `verify.lang_detected` i18n key (flat, en+ru) for the detection message.
- [ ] Tests: detection per config file; each adapter on a temp file (skip execution when the toolchain is missing — assert graceful `false`, not a throw). Commit (`feat(verifier): language adapters`).

---

## Verification Checklist

1. `bun test` — all green (expect ~1000+ tests with the new suites).
2. `tsc --noEmit` — 0 errors.
3. Manual memory gate: `bun run mma "remember that -"` → rejected; `remember convention: Use TypeScript for all new modules` → accepted; duplicate → rejected.
4. Manual learning: sandbox multi-step task → `mma learn` → draft + confirm → skill file lands in `.mma/skills/`; `< minToolCalls` session → "nothing to learn" with zero LLM calls.
5. `~/.mma/memory/*.md` stays clean after a week of normal use.
6. AGENTS.md contains both new sections.

## Execution Handoff

Two options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Phase A (Tasks 1–6) is fully isolated — no risk to current agent runs. Phase B (Tasks 7–13) is opt-in (`learning.enabled: false` default). Phase C (Task 14) is optional.
