# Harness Runaway-Session Fixes — Implementation Plan

> **Статус:** исполнено частично (сверка 2026-10-20) — все 5 задач shipped
> (`65ba2f68`): `RUNTIME_APP_DIRS` в `scripts/stage-release.ts`;
> `MAX_TOOL_FAILURES_PER_TURN` + `disabledTools`; `buildModelBlock` в системном промпте;
> `maxToolIterations: 200`; `MAX_RESEARCH_BATCHES` + `exec.research_convergence`.
> **Не закрыто: остаток Task 3** — `src/core/bootstrap/session-phase.ts:145` по-прежнему
> пишет `model=${probe.model}` (значение пробнера на момент старта, а не живой модели);
> выравнивание/пояснение не сделано.

**Goal:** Fix the harness (Agent-side) defects exposed by live session `ses_mv44qabg_s1przq` (`mma web`, `mellum2.1-12b-a2.5b-thinking`, single turn = 225 LLM calls / 225 tool calls / 15 compactions / 0 chat output / user abort after ~22 min).

**Architecture:** Small, general, additive fixes to the agent harness — no model-specific behavior, no scope creep. Each task is independent and testable without a live model.

**Tech Stack:** Bun + TypeScript (strict, NodeNext), vitest (`bun test`), Biome, fallow.

**Source audit:** see the session artifacts under `~/.mma/sessions/ses_mv44qabg_s1przq/` and `~/.mma/logs/2026-10-11.log`.

**Branch:** `fix/harness-runaway-session` (worktree `E:\projects\mma-fix-harness-runaway`), based on `master` (`a060a206`, version 0.3.2). NOT merged yet.

**Classification of the root causes (Agent = harness vs Model = LLM):**

| # | Cause | Class | Status in this plan |
|---|-------|-------|---------------------|
| 1 | Released install is missing `app/modules/browser/bridge-server.mjs` → every `browser` call dies with `Cannot find module` | **Agent (packaging bug)** | Task 1 — ✅ shipped |
| 2 | A tool that always fails but is interleaved with successes is never disabled → 17 browser retries | **Agent (loop guard)** | Task 2 — ✅ shipped |
| 3 | `download_file`/image path blocked while `web_browse` returns "(empty page)" and browser is dead → model loops on web | **Agent (tool availability)** | Task 1 + Task 2 (unblocks browser) |
| 4 | System prompt / `context_probe` report a model that isn't the active one (`qwen3.8-9b-distill` vs `mellum2.1-12b`) | **Agent (stale identity)** | Task 3 — ✅ shipped |
| 5 | `maxToolIterations` default 1000 — no turn budget | **Agent (default)** | Task 4 — ✅ shipped |
| 6 | Near-duplicate web research (42 `web_search` + 36 `web_fetch`, varied args) doesn't feed the duplicate streak | **Agent (loop guard) + Model** | Task 5 — ✅ shipped (soft convergence directive) |
| 7 | User asked for a **plan**, model built the site and ran servers; never emitted chat text; ignored "use skills"; never asked; re-planned at 7/8 | **Model (LLM)** | Out of harness scope |

**Shipped (all 5 harness tasks):** Task 1 (`fix(release): ship dist runtime dirs…`), Task 2 (`fix(agent): disable a repeatedly-failing tool…`, threshold `MAX_TOOL_FAILURES_PER_TURN = 8` — above the failed-batch terminal so single-tool loops keep their contract), Task 3 (`fix(prompt): live model identity…`), Task 4 (`maxToolIterations` default 1000→200), Task 5 (web-research convergence directive, `MAX_RESEARCH_BATCHES = 12`, soft/no-hard-stop). `bun test` 3842 pass / 0 fail; `bun run quality` exit 0.

**Residual (documented, not code):**
- **`context_probe` entry** (`model=qwen3.8… actual=262144` at 18:01:15) reflects what the *provider probe* saw at that instant, before the user's model switch; the prompt identity is now live, so the entry is observability-only. Align separately if desired.
- **Task 5 is intentionally soft.** A hard web-research stop was rejected on purpose: the project already reverted a broad read-only budget (`MAX_READONLY_BATCHES`, `docs/specs/2026-10-09-readonly-guard-finalize-design.md`). If live runs show the directive is not enough, the next step needs its own spec + live validation, not a quick threshold change.

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

- [x] **Step 1: Make `buildStage` importable and list the runtime dirs**

Refactor `scripts/stage-release.ts`: export a `RUNTIME_APP_DIRS` constant (`["modules", "skills", "certification"]`) and `export async function buildStage(...)`, guard the top-level `await main()` behind `if (import.meta.main)`.

- [x] **Step 2: Write failing test** `tests/scripts/stage-release.test.ts`

Run `buildStage` into a temp dir with `RELEASE_SKIP_NODE_MODULES=1` and a fake `dist` (or reuse the repo `dist`). Assert:
- `app/modules/browser/bridge-server.mjs` exists,
- `app/skills/builtin` exists (non-empty),
- `app/certification/certifications.json` exists.

But `buildStage` also copies `process.execPath` (bun, ~90MB) — slow. Refactor to copy the runtime only when `RELEASE_SKIP_RUNTIME !== "1"`, mirroring `RELEASE_SKIP_NODE_MODULES`. Test sets both skips.

- [x] **Step 3: Implement** — copy each `dist/<dir>` into `app/<dir>`.

- [x] **Step 4: Verify** `bun test tests/scripts/stage-release.test.ts` green.

- [x] **Step 5: Commit** `fix(release): ship dist/modules, dist/skills, dist/certification in the tarball`

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

- [x] **Step 1:** failing test: 5 failing batches of the same non-transient tool ⇒ `state.disabledTools.has("browser")`, a `<system-summary>` directive is added once; transient tools (`web_fetch`) are NOT disabled.
- [x] **Step 2:** verify fails.
- [x] **Step 3:** implement.
- [x] **Step 4:** green.
- [x] **Step 5:** commit `fix(agent): disable a repeatedly-failing tool for the rest of the turn`

**Note:** keep `TRANSIENT_TOOLS` (web_fetch/web_search/web_browse) out — their failures are legitimate (404/TLS) and already excluded.

---

## Task 3: Live model identity in the system prompt

**Problem:** `buildSystemInfo` baked `${config.model}` into the static system-info block once at bootstrap; `Agent.reconfigure` (model/provider switch) does not rebuild it → the prompt kept saying `qwen3.8-9b-distill` while the turn ran `mellum2.1-12b`.

**Fix (chosen approach — dynamic block, no cross-phase plumbing):** the model name is now a *dynamic* prompt block recomputed every `buildSystemPrompt`, so it always reflects the live config. The static header no longer embeds a model name (single source of truth → no divergence).

**Files (shipped):**
- `src/core/system-prompt.ts` — new `buildModelBlock(model)`; header drops `(${config.model})`.
- `src/core/bootstrap/modules-phase.ts` — `collectDynamicPromptBlocks` pushes `buildModelBlock(input.config.model)`.
- `src/core/bootstrap/session-runner-scope.ts` — `RunnerDynamicBlocksInput.config`; `buildRunnerDynamicBlocks` pushes the block.
- `src/core/bootstrap/session-runner.ts` — passes `config`.
- Test: `tests/core/system-prompt-model-block.test.ts`.

- [x] Implemented; `bun test` + `tsc --noEmit` green.
- [x] Remaining (follow-up, observability only): the `context_probe` session entry text is provider-probe-time, not live model — clarify/align separately if desired.

---

## Task 4: Turn budget default — shipped

**Problem:** `maxToolIterations` default = 1000 did not bound a runaway turn (the audited session reached 225 calls and was aborted by hand).

**Fix:** default `1000 → 200` (`src/config/defaults.ts`, `src/modules/setup/answers.ts` `SETUP_DEFAULTS`, `src/modules/webui/assets/setup.ts` fallback, `README.md`; tests `tests/config.test.ts`, `tests/webui-setup.test.ts`). A turn hitting the cap already ends with a best-effort tool-less final answer (`finalizeWithoutTools`, `stopReason: "max_iters"`), and the value stays user-configurable (`/config maxToolIterations <N>`).

---

## Task 5: Research-convergence guard — shipped (soft)

**Problem:** near-duplicate web research (42 `web_search`, 36 `web_fetch`, varied args) never fed `consecutiveDuplicateBatches`, and the "no progress" stuck-warning is a soft nudge that was ignored.

**Fix:** after `MAX_RESEARCH_BATCHES` (12) consecutive batches made up *solely* of external web tools (`web_search`/`web_fetch`/`web_browse`/`browser`/`download_file`), inject a one-time directive to converge. **Directive only, no hard stop** — for the reason below. Resets on any non-web tool.

**Files:** `src/core/agent/constants.ts` (`MAX_RESEARCH_BATCHES`), `loop-state.ts` (`consecutiveResearchBatches`/`researchNudged`), `tool-batch.ts` (`RESEARCH_TOOLS` + streak), i18n `exec.research_convergence` (en+ru); test `tests/core/tool-batch-research-convergence.test.ts`.

**Why soft:** the repo already reverted a broad read-only budget (`MAX_READONLY_BATCHES`) because it killed legitimate read-only analysis (`docs/specs/2026-10-09-readonly-guard-finalize-design.md`). A hard web stop risks the same class of false positive (a genuinely large web-research task). The set here is external-web only (local analysis unaffected) and self-resets. If live runs show the directive is insufficient, the hard stop needs its own spec + live validation.

---

## Verification

- `bun test` (full suite) — 3842 pass / 0 fail.
- `bun run quality` (typecheck + typecheck:frontend + lint + fallow) — exit 0.

## Out of scope (Model-side, not harness)

Scope drift (plan → build), no chat output, ignoring "use skills", no `question`, re-planning at 7/8, not using `download_file`. These are LLM-quality issues; the harness fixes above remove the traps that amplified them.
