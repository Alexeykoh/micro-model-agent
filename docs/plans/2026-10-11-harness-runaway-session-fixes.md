# Harness Runaway-Session Fixes — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD: failing test → minimal fix → green.

**Goal:** Fix the harness (Agent-side) defects exposed by live session `ses_mv44qabg_s1przq` (`mma web`, `mellum2.1-12b-a2.5b-thinking`, single turn = 225 LLM calls / 225 tool calls / 15 compactions / 0 chat output / user abort after ~22 min).

**Architecture:** Small, general, additive fixes to the agent harness — no model-specific behavior, no scope creep. Each task is independent and testable without a live model.

**Tech Stack:** Bun + TypeScript (strict, NodeNext), vitest (`bun test`), Biome, fallow.

**Source audit:** see the session artifacts under `~/.mma/sessions/ses_mv44qabg_s1przq/` and `~/.mma/logs/2026-10-11.log`.

**Branch:** `fix/harness-runaway-session` (worktree `E:\projects\mma-fix-harness-runaway`), based on `master` (`a060a206`, version 0.3.2). NOT merged yet.

**Classification of the root causes (Agent = harness vs Model = LLM):**

| # | Cause | Class | Status in this plan |
|---|-------|-------|---------------------|
| 1 | Released install is missing `app/modules/browser/bridge-server.mjs` → every `browser` call dies with `Cannot find module` | **Agent (packaging bug)** | Task 1 |
| 2 | A tool that always fails but is interleaved with successes is never disabled → 17 browser retries | **Agent (loop guard)** | Task 2 |
| 3 | `download_file`/image path blocked while `web_browse` returns "(empty page)" and browser is dead → model loops on web | **Agent (tool availability)** | Task 1 + Task 2 (unblocks browser) |
| 4 | System prompt / `context_probe` report a model that isn't the active one (`qwen3.8-9b-distill` vs `mellum2.1-12b`) | **Agent (stale identity)** | Task 3 |
| 5 | `maxToolIterations` default 1000 — no turn budget | **Agent (default)** | Task 4 (docs/decision) |
| 6 | Near-duplicate web research (42 `web_search` + 36 `web_fetch`, varied args) doesn't feed the duplicate streak | **Agent (loop guard) + Model** | Task 5 (design note, not coded) |
| 7 | User asked for a **plan**, model built the site and ran servers; never emitted chat text; ignored "use skills"; never asked; re-planned at 7/8 | **Model (LLM)** | Out of harness scope |

---

## Task 1: Ship runtime-read directories in the release artifact

**Problem:** `scripts/stage-release.ts` copies only `dist/main.js` and `dist/assets` into `app/`. The runtime reads other `dist/**` paths from disk:
- `dirname(import.meta.url) + "/modules/browser/bridge-server.mjs"` → `app/modules/browser/bridge-server.mjs` (`src/modules/browser/bridge-client.ts`); created by `scripts/copy-assets.ts` at `dist/modules/browser/bridge-server.mjs`.
- `dirname(import.meta.url) + "/skills/builtin"` → `app/skills/builtin` (`src/core/bootstrap/workspace-phase.ts:128`); created by `copy-assets` at `dist/skills/builtin`.
- `dirname(import.meta.url) + "/certification/certifications.json"` → `app/certification/certifications.json` (`src/modules/certification/manifest.ts`); created by `copy-assets` at `dist/certification/certifications.json`.

Result: released installs (GitHub Releases tarballs) have a dead browser tool and no builtin skills.

**Files:**
- Modify: `scripts/stage-release.ts`
- Modify: `scripts/copy-assets.ts` (only if needed — it already produces the dirs)
- Test: `tests/scripts/stage-release.test.ts` (new)

- [ ] **Step 1: Make `buildStage` importable and list the runtime dirs**

Refactor `scripts/stage-release.ts`: export a `RUNTIME_APP_DIRS` constant (`["modules", "skills", "certification"]`) and `export async function buildStage(...)`, guard the top-level `await main()` behind `if (import.meta.main)`.

- [ ] **Step 2: Write failing test** `tests/scripts/stage-release.test.ts`

Run `buildStage` into a temp dir with `RELEASE_SKIP_NODE_MODULES=1` and a fake `dist` (or reuse the repo `dist`). Assert:
- `app/modules/browser/bridge-server.mjs` exists,
- `app/skills/builtin` exists (non-empty),
- `app/certification/certifications.json` exists.

But `buildStage` also copies `process.execPath` (bun, ~90MB) — slow. Refactor to copy the runtime only when `RELEASE_SKIP_RUNTIME !== "1"`, mirroring `RELEASE_SKIP_NODE_MODULES`. Test sets both skips.

- [ ] **Step 3: Implement** — copy each `dist/<dir>` into `app/<dir>`.

- [ ] **Step 4: Verify** `bun test tests/scripts/stage-release.test.ts` green.

- [ ] **Step 5: Commit** `fix(release): ship dist/modules, dist/skills, dist/certification in the tarball`

---

## Task 2: Disable a tool that keeps failing within a turn

**Problem:** `tool-batch.ts` `recordRepeatedToolFailure` already counts total (not just consecutive) per-tool failures and writes a memory rule at `MIN_REPEATED_TOOL_FAILURES` (3) — but the tool stays available and the model retried `browser` 17× in one turn. Fix: after a higher threshold (`MAX_TOOL_FAILURES_PER_TURN`, e.g. 5) of non-transient failures, mark the tool disabled for the rest of the turn, drop it from the visible tool set, and inject one directive.

**Files:**
- Modify: `src/core/agent/loop-state.ts` (add `disabledTools: Set<string>`, `toolDisabledNudged: Set<string>`)
- Modify: `src/core/agent/constants.ts` (`MAX_TOOL_FAILURES_PER_TURN`)
- Modify: `src/core/agent/tool-batch.ts` (`recordRepeatedToolFailure` → disable + directive)
- Modify: `src/core/agent.ts` (filter `disabledTools` when building the visible tool set, ~line 1009–1028)
- i18n: `src/i18n/en.json`, `src/i18n/ru.json` (`exec.tool_disabled`)
- Test: `tests/core/tool-batch-tool-disable.test.ts` (new)

- [ ] **Step 1:** failing test: 5 failing batches of the same non-transient tool ⇒ `state.disabledTools.has("browser")`, a `<system-summary>` directive is added once; transient tools (`web_fetch`) are NOT disabled.
- [ ] **Step 2:** verify fails.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** green.
- [ ] **Step 5:** commit `fix(agent): disable a repeatedly-failing tool for the rest of the turn`

**Note:** keep `TRANSIENT_TOOLS` (web_fetch/web_search/web_browse) out — their failures are legitimate (404/TLS) and already excluded.

---

## Task 3: Live model identity in the system prompt

**Problem:** `buildSystemInfo` bakes `${config.model}` into the static system-info block once at bootstrap; `Agent.reconfigure` (model/provider switch) does not rebuild it → the prompt kept saying `qwen3.8-9b-distill` while the turn ran `mellum2.1-12b`.

**Files:**
- Modify: `src/core/bootstrap/workspace-phase.ts` (give the block `kind: "system-info"`; keep the builder function accessible)
- Modify: `src/core/bootstrap.ts` / `AgentDeps` (expose `rebuildSystemInfoBlock?: () => PromptBlock`)
- Modify: `src/core/agent.ts` `reconfigure` (swap the `kind: "system-info"` block)
- Test: `tests/core/reconfigure-prompt-model.test.ts` (new)

- [ ] Steps: failing test (prompt contains old model → reconfigure with new model → `buildSystemPrompt()` contains new model, not old) → implement → green → commit.

---

## Task 4: Turn budget default (decision, docs)

**Problem:** `maxToolIterations` default = 1000 (`src/config/defaults.ts`, `src/config/config.ts`). A single turn can burn hundreds of iterations (observed 225).

**Decision to record:** do NOT silently lower the default (breaking for legit long tasks); instead document the interaction with `finalizeWithoutTools` and the loop guards (Task 2 / duplicate budget), and recommend a turn-level safety in a follow-up spec. Update `docs/agents/execution.md` if behavior is clarified.

Status: **plan-only** (no code) unless the user wants the default changed.

---

## Task 5: Research-convergence guard (design note)

**Problem:** near-duplicate web research (42 `web_search`, 36 `web_fetch`, varied args) never feeds `consecutiveDuplicateBatches`, and the "no progress" stuck-warning is a soft nudge.

**Constraint:** the repo already removed a broad read-only budget (`MAX_READONLY_BATCHES`) because it killed legitimate read-only analysis (`docs/specs/2026-10-09-readonly-guard-finalize-design.md`). A new web-specific budget must be narrow (only `web_search`/`web_fetch`/`web_browse`/`browser`/`download_file` batches, high threshold) and must reset on any productive action.

Status: **plan-only** — needs its own spec + live validation before coding; naive query normalization (token-set) does not catch the observed variation, so it is not a clean win.

---

## Verification

- `bun test tests/scripts/stage-release.test.ts tests/core/tool-batch-tool-disable.test.ts tests/core/reconfigure-prompt-model.test.ts`
- `tsc --noEmit`
- `bun run quality` (typecheck + typecheck:frontend + lint + fallow) — update `.fallow-baseline.json` only if fallow flags intentional new exports.

## Out of scope (Model-side, not harness)

Scope drift (plan → build), no chat output, ignoring "use skills", no `question`, re-planning at 7/8, not using `download_file`. These are LLM-quality issues; the harness fixes above remove the traps that amplified them.
