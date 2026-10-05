# Changelog

All notable changes to Micro Models Agent (MMA) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Compaction progress threshold** (`src/core/agent/compaction.ts`, `src/modules/context/manager.ts`): the significance threshold is now `max(2% history budget, 3% current context)` instead of 2% of the history budget alone, so a marginal shrink (e.g. −1.2% on a 24K context) no longer counts as success and short-circuits stage escalation — it now escalates to `aggressive`/`hard-drop`. `compactAdaptive` reports `reducedBy` as the total reduction from the original context (previously measured incrementally between stages, which could understate real progress to 0). An overflow attempt now consumes the iteration even when it is a no-op, keeping the "one trigger per iteration" guarantee.

## [2.19.0] - 2026-10-05

Harness hardening from the live-session post-mortem (`ses_muu8kfbw_nyxkre`): false
compaction and lost working context, plan/step desync, broken `grep` on Windows,
background-process leaks. Harness fixes only (no model/task-specific tuning).

### Added

- **Context calibration** (`src/core/agent/context-calibration.ts`): the token estimate is calibrated against real provider `prompt_tokens` (baseline+delta, EMA fallback, floor-ratio against silent provider truncation, shadow warmup, stale fallback). `ContextManager.getContextTokens()` is the single input for compaction thresholds; `getEstimatedTokens()` stays raw for cost/prefix/critic. New diagnostic fields (`estimatedTokensRaw`, `contextTokens`, `calibrationRatio`, `calibrationState`) in the `context` session event.
- **Safety-clamp** (`isImplausibleJump`): an implausible estimate jump (>3× and >20K tokens without message growth) no longer triggers overflow compaction.
- **Compaction policy v2** (`contextBudget.policy: legacy|v2`, default `v2`): canonical `history` threshold, overflow cooldown, progress guarantee (prune old tool results → aggressive trim → hard drop), pinned task/plan, one trigger per iteration, and reactive compaction on a provider context-length error (circuit-broken once per turn). `legacy` reproduces 2.18.2.
- **Plan ownership**: `execution.autoAdvance` (default true); auto-archived plans now archive at the turn boundary (not mid-turn) and the model gets an explicit notice; `plan.no_active` reports the last completed plan; plan `checks` are optional and self-certify (`manual:<step>`) when omitted.
- **Tool portability**: zero-dependency JS `grep` fallback (rg → grep → built-in walker respecting `.gitignore`/`.mmaignore`, size/time/maxFiles limits) with `tools.grepEngine: auto|rg|grep|js`; generic bash redirect for a registered tool invoked as a shell command and a generic `--cwd` → `workdir` hint; `ProcessRegistry` dedups identical running background commands (`force: true` to bypass).
- **Weak-model UX**: `ToolResult.errorMeta` (`code`/`retryable`/`hint`) delivered to the model without leaking into the chat; fuzzy top-3 `load_skill` suggestions; empty web message returns a localized no-op instead of a hard error.
- New config keys (registry + i18n en/ru): `contextBudget.policy`, `contextBudget.overflowCooldown`, `contextBudget.toolResultKeep`, `contextBudget.calibrationWarmup`, `contextBudget.ratioFloor`, `execution.autoAdvance`, `tools.grepEngine`.

### Changed

- **Compaction** thresholds now use the calibrated estimate; `legacy` policy keeps raw behaviour.
- **Plan auto-archive** moved from the auto-advance mutation to `onTurnEnd` (web/REPL turns no longer see "no active plan" mid-work).

### Fixed

- **Token-estimate cache** (`src/modules/context/manager.ts`): the per-message cache is now keyed by a content signature, so an in-place mutation cannot return a stale estimate (root-cause class of the phantom +44K jump).
- **`grep` on Windows** no longer fails with `Executable not found in $PATH: "grep"` — the built-in walker runs when neither `rg` nor `grep` exists.
- **Cost hidden for `deepseek-v4.1-flash`** (`src/modules/pricing/prices.ts`): the Zen/Go price table had `deepseek-v4-flash`/`deepseek-v4-pro` but not `deepseek-v4.1-flash`, so `resolvePrice` returned `undefined` and no cost was shown for the model the `opencode-go` provider remembers. Added the entry and corrected the stale DeepSeek prices/cached-read rates to the current Go off-peak table.

## [2.18.2] - 2026-10-04

### Fixed

- **Question memory pre-check suppressed project questions** (`src/tools/question.ts`): the keyword-overlap threshold counted option labels/descriptions as if they were the question intent, so a generic profile fact (`Стек: JavaScript/TypeScript, Python`) matched "Какой стек технологий предпочтительнее для лендинга?" via "TypeScript"/"разработка" in the options and silently suppressed it. The small model then looped on `question` (every result `memory_known`) and finally dumped the question as plain text, ending the turn. The threshold now counts only `question` + `header` keywords - option wording is answer vocabulary, not the question.
- **Repeated memory-known question now hard-stops** (`src/tools/question.ts`, i18n `tool.question.memory_repeat`): the same question reported as known twice in a session returns an explicit "do not call question again, continue with the known value" directive. `tool.question.memory_only` / `tool.question.memory_known` no longer end on the contradictory "these were NOT asked" without a follow-up instruction.

### Added

- **`markRepeatedKnown`** (`src/tools/question.ts`): per-session (WeakMap by tool context) tracking of questions already reported as memory-known, powering the anti-loop directive.

## [2.18.1] - 2026-10-04

### Changed

- **README rewritten in English** (`README.md`): fully translated from Russian, reorganized into scannable themes (agent loop / orchestration / tools / experience / safety), and given a sharper intro and feature framing. Content — commands, config, tools, architecture, testing, principles — preserved. Documentation only, no behavior change.

## [2.18.0] - 2026-10-04

### Added

- **Symbol-level project map** (`src/modules/indexer/symbols.ts`): extraction now carries a 1-based `line` and a `kind` (`function`/`class`/`interface`/`type`/`export`/…) alongside the name, for every supported language. `extractSymbols` (names only) stays for compatibility; `extractSymbolsDetailed` is the new source.
- **`project_map` actions `symbol` and `outline`** (`src/modules/indexer/module.ts`, `rank.ts`): `symbol` locates definition sites (`path:line name (kind)`, ranked exact→prefix→substring), `outline` returns a file's symbol table of contents by line. Both stay on the existing tool, so the tool count and context budget are unchanged.
- **Symbol signatures (no parser dependency)** (`src/modules/indexer/symbols.ts`): each symbol now carries the declaration text up to `{`/`;`/end-of-line, bracket-depth aware for multi-line parameters — e.g. `rankFiles (function) — export function rankFiles(files: IndexedFile[], query: string): RankedFile[]`. Coverage on this repo is ~83% of extracted symbols at no measurable index-time cost; shown in `symbol` and `outline` results so the model sees the API without reading bodies.
- **Definition-first, path-aware ranking for `find`** (`src/modules/indexer/rank.ts`): exact symbol name > prefix > substring > path, source > tests > docs, then shorter path and stable order. Measured on this repo: MRR 0.93→1.00, Hit@1 0.90→1.00 over 60 symbol queries (ambiguous queries such as `plugin` move from rank 7 to rank 1).
- **Incremental re-index by mtime** (`src/modules/indexer/walker.ts`, `cache.ts`): `IndexedFile` carries `size`/`mtimeMs`; `walk(prev)` reuses unchanged files (no read, no regex) and re-reads only changed ones. On a synthetic 3000-file tree, rebuilding after a one-file edit drops from ~302 ms to ~168 ms (1.8×). Cache schema bumped to v3.
- **Indexer config** (`config.indexer.maxFiles`, `config.indexer.respectGitignore`): the file cap is now configurable (default **1000 → 5000**) and surfaced in `/config` and Settings → Context → Project index; when the cap is hit the map shows an explicit truncation marker instead of silently listing a subset.
- **`.gitignore` / `.mmaignore` support** (`src/modules/indexer/gitignore.ts`): best-effort matcher (comments, `!` negation, `/` anchoring, `dir/`, `*`, `?`, `**`), fail-open. On this repo it filters 971 → 934 indexed files.
- **PageRank-ranked project map under a token budget** (`src/modules/indexer/graph.ts`, `rank.ts`, `module.ts`): a file→file reference graph is built from imports/require (local specifiers and path aliases resolved), PageRank scores architectural importance, and `selectByRank` fits the highest-ranked files into `indexer.mapTokenBudget` (default 1500 tokens) instead of a fixed 80-file list. On this repo the map shrinks 2444 → 1481 tokens (80 → 40 files) while surfacing hubs (types/registry modules).
- **LSP-backed symbol lookup** (`src/modules/lsp/symbols.ts`, `client.ts`, `module.ts`, `config.ts`; `IndexerModule.setSymbolProvider`): `project_map symbol` falls back to LSP `workspace/symbol` when the index finds no match, returning precise definitions (`workspace/symbol` is the correct LSP primitive for lookup by name; `textDocument/definition` needs a position). Wired in bootstrap so the language server is spawned only on a miss, never per query; disabled/erroring LSP degrades to the index silently.

### Changed

- **Search latency trade-off**: ranked `find` costs ~1.6 ms per query vs ~0.4 ms for the old linear filter on an ~930-file index — still sub-2ms and independent of result count; symbol/outline give the model a direct path to definitions.

## [2.17.0] - 2026-10-02

### Added

- **`/lsp doctor`** (`src/cli/repl-commands-lsp.ts`, `src/modules/lsp/diagnose.ts`): per-server diagnosis — applicability, whether the binary is on PATH, whether npx would be used, a real `spawn+initialize` probe, and a **classified reason** (`ok` / `disabled` / `not-applicable` / `binary-missing` / `offline` / `network` / `timeout` / `spawn-failed` / `server-error` / `deadline`) with an actionable hint. Answers "why is LSP dead" instead of leaving it in `app.jsonl`. `LspModule.diagnose(baseDir)` + `diagnoseLspServers`.
- **Offline mode `MMA_LSP_OFFLINE=1`** (`src/modules/lsp/resolve.ts`, `client.ts`, `config/env.ts`): never invoke npx; only PATH binaries are used, and a server that would need npx fails fast with a clear `offline: <binary> not found in PATH (MMA_LSP_OFFLINE)` message.
- **Classified failure hints** (`src/modules/lsp/module.ts`): a failed check appends one `hint:` line under `[LSP check failed]` (binary missing / network / offline / spawn / timeout) so the model falls back to the project's own build/test instead of blindly retrying.
- **`resolve.ts`** — extracted npx→global-binary resolution (`findOnPath`, `resolveNpxLaunch`) shared by the client and the doctor.
- **Docs**: `docs/agents/tools.md` "LSP in locked-down networks" (PATH binaries, `lsp.servers.<lang>` overrides, registry mirror via `env`, `MMA_LSP_OFFLINE`, classes table).

## [Unreleased]

## [2.17.2] - 2026-10-04

### Changed

- **Docs**: refresh README, AGENTS.md and `docs/agents/*` for the TypeScript frontend and the optimized build — dev commands (`typecheck:frontend`), minified `build:prod` (external deps + esbuild), corrected stale frontend `.js` paths.

## [2.17.1] - 2026-10-04

### Changed

- **npm package build optimized (internal)**: the CLI bundle externalizes its dependencies (`bun build --packages external`) and the whole `dist` is minified with esbuild (`scripts/optimize-dist.ts`; no source maps, identifier mangling) — package **8.17 MB → 1.73 MB**, `main.js` **7.68 MB → 1.11 MB**. `build:prod` now cleans `dist` first (portable `scripts/clean.ts`), the frontend build skips empty type-only outputs, and nothing is downloaded at runtime (all deps ship via `npm install`). `token-counter.ts` switches to `js-tiktoken/lite` + `cl100k_base` (~1.1 MB vs ~5.6 MB) and `estimateTokens` is recalibrated for cl100k. Spec: `docs/specs/2026-10-04-npm-build-optimization-design.md`.

- **WebUI frontend migrated to TypeScript (internal)**: every first-party browser module under `src/modules/webui/assets` is now `.ts` (`app.ts`, `md.ts`, `setup.ts`, `js/**/*.ts`) checked with `strict: true` via a new `tsconfig.frontend.json` (`typecheck:frontend`, added to `quality`); the backend `tsconfig.json` excludes `assets/**`. `loadAssets()` transpiles `.ts` on the fly with `Bun.Transpiler` (dev/tests, no build step), while `scripts/build-frontend.ts` emits ready `.js` into `dist/assets` for `build:prod` (same file names and module graph). `allowJs` remains only for the vendored `smd.js`. No SSE/REST/session/config/plugin/URL contract change. Spec: `docs/specs/2026-10-04-webui-frontend-ts-design.md`; plan: `docs/plans/2026-10-04-webui-frontend-ts.md`.

- **Web turns always use a per-session runner** (`src/modules/webui/turns.ts`, `module.ts`, `server.ts`, `state.ts`, `session-pool.ts`): the legacy single-agent bridge path (`hasFactory()` branches, global-FIFO drain, `drainQueueTurn`, `submitLegacy`) is removed. Every `POST /api/message` requires a session and a runner factory (`503 no_session` / `503 no_runner`), runs in that session's slot with per-session queueing, and reuses the same runner path as the parallel executor. SSE is delivered to **every** client (one browser window = several tabs; a background session must stream live); tab routing is client-side (`feedForEvent` by `sessionId`), and `broadcast` no longer auto-stamps `activeSessionId`. The main agent stays for CLI/REPL and host commands/plugins (`Host.submit` is unsupported in web). Tests: `tests/webui-server.test.ts`, `tests/webui-auth.test.ts`, `tests/webui-sse-routing.test.ts`.

- **WebUI frontend modularized (phases 5-6, internal)**: largest `assets/js` files split by seam behind barrels - `feed.js` → `feed/{core,sidebar,stream,turn,history,plan,question}.js`, `tabs.js` → `session/{tabs,composer,sessions-menu,cmdk}.js`, `settings.js` → `settings/{write,panels,providers,modal,subdialog,search,form}.js`. Mutual hub↔sibling calls are broken with injected operations (`initComposer`/`initSessionsMenu`/`initCmdk`, `setWriteHooks` for the `postConfig` funnel) so the import graph stays acyclic. The `S` god-object is split into `core/store/{index,feed,tabs,settings,session}.js` slices and removed (consumers import the domain slice). No SSE/REST/session/config/plugin contract change; frontend graph guards (`tests/webui-boundaries.test.ts`, `tests/webui-frontend-graph.test.ts`) plus `bun build app.js` and a JS `tsc` static check gate every split. Plan: `docs/plans/2026-10-02-webui-modularization.md`.

### Added

- **LSP setup controls: global toggles + manual-install hints** (`src/modules/lsp/{types,resolve,client,module,probe,startup-check,diagnose}.ts`, `src/config/registry-extra.ts`, `src/modules/webui/{state,module,host-state}.ts`, `src/modules/webui/lsp/lsp-api.ts`, `src/modules/webui/settings/config-api.ts`, `src/cli/repl-commands-lsp.ts`, `assets/js/sidebar/lsp.js`, `assets/js/subdialog.js`, `assets/js/settings/{controls,panels}.js`): the LSP sidebar gains an info button opening a **pop-up** with toggles for **LSP enabled** (`lsp.enabled`) and **offline mode** (`lsp.offline`, only globally installed binaries - env `MMA_LSP_OFFLINE` still overrides) plus per-server **manual install commands** derived from the diagnosis (`npm i -g <packages>`, `rustup component add rust-analyzer`, `go install .../gopls@latest`), shown only for applicable/problem servers. Both toggles are registry keys (work in `/config` and Settings -> Plugins LSP) and hot-apply through `LspModule.setEnabled/setOffline` (no restart); `/lsp doctor` prints the same install commands. Tests: `tests/lsp-module.test.ts`, `tests/modules/lsp/{diagnose,resolve}.test.ts`, `tests/webui-config.test.ts`.

- **Web UI incoming message queue** (`src/modules/webui/state.ts`, `util.ts`, `forward.ts`, `module.ts`, `server.ts`, `run-agent.ts`, `assets/js/tabs.js`): a message sent mid-turn no longer dies on `409 busy` — it queues (`202 {queued: n}`, cap `MAX_QUEUE_LENGTH = 5`, overflow `429 queue_full`) and runs as the next turn on `turn_end`, in order. Drain reuses the single-flight submit path; the queue clears on server stop; `GET /api/state` and SSE `state` carry `queueLen`. The composer stays editable during a turn with a `↳ queued · position N` receipt (`web.input.queued/queue_full`, en+ru; dead `web.input.busy` removed). Docs: `docs/agents/modules.md`. Tests: `tests/webui-server.test.ts`, `tests/webui-auth.test.ts`.

- **Web Trace: diagnostics coverage + full model text** (`src/modules/webui/log-api.ts`, `sessions-api.ts`, `forward.ts`, `state.ts`, `module.ts`, `assets/app.js`, `assets/js/sidebar.js`): Trace shows status rows (SSE `meta`), warn/error logs (SSE `log`, minus info-diagnostic chatter), draft retractions, and index start/done/error — plus critic/MoE/compaction/context-probe/usage/audit/claim-retry/output pulled incrementally from `session.jsonl` on every `turn_end` via the new `GET /api/sessions/:id/log` (`?types=&since=&limit=`, field whitelist, secret scrub, no new producers). `turn_end` carries a server `turnSeq`; text details show the full turn text (honest 20K cap instead of a 4K tail slice) with session/turn and a session-log provenance footer (assistant count, iterations, model/tokens). Git ops stay inside `bash` rows (prefix heuristics too fragile). i18n `web.sidebar.trace_*/detail_*` (en+ru). Tests: `tests/webui-log.test.ts`, e2e `web-boot` (Trace panel + index lifecycle).

### Fixed

- **Web feed crashed at turn end after the store-slice migration** (`assets/js/feed/{core,stream,turn}.js`): the imported `feed` state slice was shadowed by the local `feed` DOM element inside the stream/turn handlers, so `onTurnEnd` threw `TypeError: Cannot read properties of undefined (reading 'forEach')` (and stream/run bookkeeping wrote onto the DOM node). The slice import is now aliased `feedState`. Also made the Playwright e2e harness **hermetic by default** (dummy provider points at a dead port, never a lived-in local LM Studio) and refreshed stale e2e scenarios (select-based provider form, MCP toggle seed, image attach via the real file chooser, reasoning option labels). `bun run test:e2e`: 9 files / 31 tests green.

- **Web project-map watcher is now armed** (`src/modules/webui/index-watcher.ts`, `module.ts`, `host-state.ts`): the Map sidebar permanently showed **stale** in `mma web` because the indexer's file watcher was started only by the indexer plugin's `onSessionStart`, which fires from the main agent's `run()` — and web turns run in per-session runners whose plugin manager deliberately excludes the `indexer` plugin. The long-lived web host now owns the shared watcher (`attachIndexWatcher` on `startWebUi`, detached on `stop()`), so the map auto-rebuilds on file changes and **Re-index** no longer looks inert. Tests: `tests/webui-index-watcher.test.ts`.
- **Web reload no longer replays the system prompt into the chat** (`src/modules/webui/history-api.ts`): `GET /api/sessions/:id/history` mapped `session.jsonl` `system` entries (the `slog.logSystem` copy of the system prompt) and `context` snapshots ("context snapshot at session start") into the transcript, so a page reload painted the whole system prompt as a `sysline` above the conversation. Both types are now dropped like the other internal diagnostics (still available in Trace via `GET /api/sessions/:id/log`); the message-history fallback skips `role: "system"` too. Tests: `tests/webui-history.test.ts`.
- **Web file list is always expanded with full root-relative links** (`src/modules/webui/assets/js/feed.js`, `styles.css`): consecutive file rows no longer collapse into an expandable `│ N files` group (its chevron toggle failed to open) — every file tool renders its own `◇ <label> · <full-path-link> [copy] <status>` line, and the link text is the full workspace-relative path (`displayPathFromRoot`, absolute paths stripped by the workspace prefix) instead of basename + dim tail. Consecutive file/action rows are compact (`~4px` via `margin-top: -7px` compensating the `11px` feed gap, `line-height: 1.35`). Group CSS/JS removed. Tests: `tests/webui-assets.test.ts`, `tests/e2e/web-filecard.e2e-test.ts`.
- **Web transcript edges and answer separation** (`src/modules/webui/assets/styles.css`): scroll edge fades are glued exactly to the transcript edges — vertical breathing moved from the scroller to `.feed` (sticky pseudos are constrained to the padding-free content box, previously leaving a gap under the header and above the composer) and hidden fades take zero flow space (`-33px` margins neutralizing height + flex gap). Finished assistant answers carry a quiet accent rail (`.feed > .md/.ans`, `border-left: 2px solid var(--accent)`, mirroring the user block) so the result reads instantly apart from the dim tool/think process. Tests: `tests/webui-assets.test.ts`.
- **Success-claim no longer vetoed by plan-bookkeeping failures** (`src/modules/hallucination/success-claim.ts`): `checkSuccessClaim` ignores `plan`/`plan_step`/`todo` evidences — their failures police the agent's own notebook (covered by the final audit), never task outcome. Lived-in case (ses_mupgenhq_75f66l, qwen3.5-9b): an honest "tests passed" was retracted over a stale `re-plan` error ("Длина checks должна совпадать"), forcing a same-substance re-answer after the task was done. Tests: `tests/hallucination-success-claim.test.ts`.

- **Web UI boot was dead on 2.15.0** (`src/modules/webui/assets/js/settings.js`): a stray `}` in `setStaleBar` pushed `return` to top level (`Uncaught SyntaxError: Illegal return statement`), killing the whole `app.js` import graph — blank page, no feed, selectors stuck at `–`. One-line brace fix.
- **Web e2e boot smoke** (`tests/e2e/web-boot.e2e-test.ts`): `mma web` boots in a real Chromium with zero console/page errors (live session tab, chrome skeleton, settings modal) and every served JS module in the live `/app.js` import graph answers 200; `web-helpers.launch` now names collected console errors when the feed never boots, so the next broken module fails with its `SyntaxError` in the message instead of a bare timeout.

## [2.16.1] - 2026-10-01

### Added

- **Smooth streamed-text cascade** (`src/modules/webui/assets/js/feed.js`, `md.js`, `styles.css`): live markdown chunks are buffered and flushed once per animation frame (`requestAnimationFrame`, multi-feed safe) instead of write+scroll per SSE event, and each streamed text run renders in a `span.tk` with a short opacity-only `tkIn` fade (staggered `(n%4)*20ms`, `.15s`). History render and code blocks skip the animation; killed by `prefers-reduced-motion`.

## [2.16.0] - 2026-10-01

### Added

- **Web dropdown search for models and sessions** (`src/modules/webui/assets/js/settings.js`, `tabs.js`, `format.js`, `index.html`, `styles.css`, `src/i18n/en.json`, `ru.json`): the composer model menu and the sessions dropdown (`☰`) gain a sticky search field — case-insensitive substring (`matchesQuery` in `format.js`; sessions match name + id) with keyboard support (`↓` into the list, `Enter` picks the first hit, `Esc` clears/closes, `↑` back to search). The sessions input lives statically in the markup so the 2s state poll never steals the caret; the model filter survives list re-reads and clears on pick. Empty sections hide with their headers, zero hits show `no matches`; `↻ refresh` / `+ new session` stay outside the filter. New keys `web.selectors.search_models` / `web.sessions.search` (en+ru). Tests: `tests/webui-assets.test.ts`.

## [2.15.0] - 2026-10-01

### Added

- **Web UI: stale-translations badge** (`src/modules/webui/i18n-stale.ts`, `i18n-api.ts`, `host-state.ts`, `core/host.ts`, `assets/index.html`, `js/dom.js`, `js/settings.js`, `app.js`, `styles.css`): `GET /api/i18n` and the state snapshot carry `i18nStale` (dict files on disk newer than the server process); the topbar shows a yellow badge with a reload action instead of silently rendering raw keys. New keys `web.i18n.stale`/`web.i18n.reload` (en+ru). Tests: `tests/webui-i18n.test.ts`, `tests/webui-usage.test.ts`, `tests/webui-assets.test.ts`.

### Fixed

- **Plan auto-advance no longer completes modify-steps on stale files** (`src/modules/execution/module.ts`): `advancePlanIfStepComplete` and final-audit `autoCloseEvidenceSteps` now require `provablyStale()` to be false — every named file must be created/modified after `plan.createdAt` (fail-open on bad dates and unreadable mtimes, delete-kind unchanged). Previously a step naming a long-existing file auto-completed before a line of code was written (observed: 6 plan steps auto-closed while the agent was still on step 1). Tests: `tests/execution-plan-deliverables.test.ts`.
- **Critic evidence includes git-tracked changes** (`src/modules/critic/evidence.ts`): `buildEvidencePack` unions tool-arg file lists with `git status --porcelain` (staged + unstaged + untracked, capped, fail-open outside repos), so edits made outside file tools (helper scripts via bash, heredocs) no longer produce false `concern` verdicts about missing changes. Tests: `tests/critic-evidence.test.ts`.
- **Repeated-failure memory writes are diagnosed, model misses skipped** (`src/core/agent/tool-batch.ts`, `loop-state.ts`): `diagnoseRepeatedFailures()` records distinct error headlines with signature-based cause/solution (edit_file anchor miss → CRLF/stale-read hypothesis) and skips global-memory writes for model errors (invented test paths, exit-code-only grep misses). Previously boilerplate causes and the model's own wrong guesses landed in `errors.md`. Tests: `tests/tool-failure-diagnosis.test.ts`.
- **Factual check resolves path suffixes** (`src/modules/hallucination/factual.ts`): `webui/state.ts` now matches `src/modules/webui/state.ts` via the cached basename index (no new FS walks), fixing false "mentioned files not found" warnings on short paths. Tests: `tests/hallucination-factual.test.ts`.
- **`edit_file` tolerates LF anchors in CRLF files** (`src/tools/edit-file.ts`): `spliceNormalized()` matches on normalized line endings and splices the original, keeping the file's ending style (no more "string not found" loops on Windows checkouts). Tests: `tests/edit-file.test.ts`.
- **Web usage re-render covers the context breakdown** (`src/modules/webui/assets/js/feed.js`): `h.contextBreakdown` added to the `renderUsage` signature so part shifts at constant used/limit repaint the segmented bar and legend. Guard: `tests/webui-assets.test.ts`.
- **Terminal context-budget part words are localized** (`src/cli/repl.ts`, `src/i18n/en.json`, `ru.json`): the startup banner showed untranslated latin `sys/res/hist` in both locales; now `repl.ctx_part_system/reserve/history` (`system/reserve/history` + `система/резерв/история`). Web legend (usage parts) intentionally unchanged. Tests: `tests/i18n.test.ts`.
- **Verification hygiene is model-facing** (`src/core/system-prompt.ts`, `src/tools/browser.ts`): verification `mma web` servers must run isolated (`MMA_CONFIG_DIR`), never against the user's live server; without vision capabilities the browser description steers to snapshot text and DOM/API assertions. Tests: `tests/core/bootstrap.test.ts`, `tests/tools/browser.test.ts`.

## [2.14.0] - 2026-10-01

### Changed

- **Web UI**: file actions now render as quiet terminal-style lines instead of boxed cards (`src/modules/webui/assets/js/feed.js`, `styles.css`). Each file tool shows `◇ <label> · <path-link> [copy-icon] <status>` in the tool-category color — no more Open/Download/Path pill buttons (path click opens the viewer, copy is an icon-only hover action). Consecutive file rows collapse into an expandable `│ N files` group with a chevron toggle. File-type badges are gone (format detection stays silent for highlighting only; draw.io hint is verbose-only). Dead strings `web.card.open/download/copy_path/download_title` removed, count via new `web.card.files_*` (en+ru). Tests: `tests/webui-assets.test.ts`, `tests/webui-smoke.test.ts`, new `tests/e2e/web-filecard.e2e-test.ts`.

## [2.13.1] - 2026-09-30

### Fixed

- **In-loop critic is now selective instead of always-on** (`src/core/agent/critic-gate.ts`, `loop-state.ts`, `src/core/agent.ts`): evidence is scoped to the current run (`LoopState.criticHistoryMark` + `gatherTurnToolEvents(cm, mark)`), so tool calls from previous questions no longer testify against the current task (observed: weather lookups from an earlier turn caused 4 false `critical` verdicts on a chat-only "show a React example" answer). Chat-only turns (no tool events in the run) now `pass` without an LLM call and without spending `maxCalls`; the dead mid-turn `mutationsSinceCritic` trigger branch is removed.
- **Advice and repeat verdicts no longer retry** (`src/core/agent/critic-gate.ts`, `src/i18n/en.json`, `ru.json`): only a fresh `critical` inside `maxRepairCycles` repairs + retries; `concern`, over-budget `critical` and near-identical repeats inject `<system-summary>` (`critic.advice`, new `critic.repeat` — "change approach or finish honestly") and `pass`. Previously every non-ok verdict retried identically until `maxCalls`, looping the same answer 4 times.
- **Critic sees chat-delivered answers** (`src/modules/critic/types.ts`, `evidence.ts`, `client.ts`, `src/core/agent.ts`): `EvidencePack.answerExcerpt` (≤2000 chars, secrets redacted) carries the final text for mutation-free turns, and the critic prompt states that a chat answer without files is not itself an issue. Previously the critic judged chat tasks blind (tools only) and demanded file artifacts the user never asked for.
- **Honest critic evidence bits** (`src/modules/critic/evidence.ts`, `provider.ts`): successful bash no longer gets a synthesized `exitCode: 0` (`undefined` renders as `?`; `1` stays for known failures); setting `critic.provider` without `critic.model` now warns instead of silently doing nothing.
- **Method calls no longer flagged as missing files** (`src/modules/hallucination/js-identifiers.ts`): `extractFileLikeTokens` drops tokens glued to `(` (`prev.map(`, `todos.map(` — `map` is a sourcemap extension), fixing false "mentioned files not found" warnings on code answers. Applies to all consumers (factual check, execution auditor, verifier).
- **Rejected drafts no longer duplicate in the feed** (`src/core/agent/artifact-resolve.ts`, `hallucination-gate.ts`, `critic-gate.ts`, `audit-gate.ts`, `src/core/types.ts`, `src/modules/webui/forward.ts`, `assets/js/feed.js`, `app.js`): a gate-rejected draft was already streamed before the verdict, so the re-answer stacked as a visible double (observed: artifact-claim false positive on bare `game.ts` vs `src/game.ts`). Gates now emit `onMeta(…, "retract")` (new `MetaKind`, user line `ui.draft_retracted` en+ru); the web forwarder sends a dedicated SSE `retract` event and `feed.js onRetract` removes the rejected block (also from turn copy buffers) with a one-line note, the terminal prints the same line. Rejections are logged as `claim_retry` session entries (`SessionLogger.logClaimRetry`, new `SessionLogEntry.kind`), closing the `llm_usage`-without-`assistant` gap; critic verify exceptions now log a fail-open diagnostic instead of a silent lone `critic_check`.
- **Artifact ground-check resolves bare basenames** (`src/core/agent/artifact-resolve.ts`): `resolveOneArtifact` goes through the auditor's `findExistingFile` (exact path, then basename/suffix subtree walk in the `baseDir` jail) instead of a strict `resolve`, so `game.ts` matches `src/game.ts` and no longer triggers a false claim-retry.

## [2.13.0] - 2026-09-30

### Added

- **Web UI**: sidebar tabs — Session / Map / Trace. Square icon tabs with the active
  tab name shown below them (`assets/js/sidebar.js`, `index.html`, `styles.css`).
- **Map tab**: project-map index state — status, last-updated timestamp, watcher,
  files/symbols/tokens, root, per-language breakdown, and a Re-index button
  (`POST /api/index`). `IndexerModule.mapInfo()` + `ProjectMapInfo` host contract.
- **Trace tab**: live per-session log of tool calls, phases, plan updates, errors,
  questions and the answer text stream; clicking a row opens a detail panel (full
  args, output, metadata) and doubles the sidebar width. Desktop only (hidden ≤760px).
- **i18n**: `web.sidebar.tab_*`, `web.sidebar.map_*`, `web.sidebar.trace_*`,
  `web.sidebar.detail_*` (en + ru).

## [2.12.0] - 2026-09-29

### Added

- **Session-bound plans** (`src/modules/execution/plan-store.ts`, `module.ts`, `src/core/bootstrap/modules-phase.ts`, `src/cli/repl-commands.ts`, `src/modules/webui/sessions-api.ts`, `state.ts`, `module.ts`, `assets/js/tabs.js`): the active plan is now stored per session (`.mma/plans/sessions/<sessionId>/active.json`) instead of a single project-global `active.json`. Switching sessions (`/resume`, `/new`, `POST /api/sessions/activate` / `POST /api/sessions`) moves the `ExecutionModule` tracker to that session's plan (new sessions start plan-less, `/resume` prints a `◇ <plan>` status line); deleting a session drops its plan slot. Plan tools writing past `setPlan` (`abort`/`switch`/`delete`/`purge`) and internal saves mirror the slot, so an aborted plan never resurrects on return. Drafts/archive stay a shared library; the legacy global plan is adopted by the active session on first start after upgrade. Web sidebar refreshes immediately after tab switch instead of waiting for the 2s poll. Spec: `docs/specs/2026-09-29-session-plan-binding-design.md`.

### Fixed

- **Provider identity sync on swap** (`src/modules/providers/manager.ts`, `src/config/registry.ts`, `src/core/agent.ts`): switching `provider.active` now mirrors the legacy flat fields (`baseUrl`/`apiKey`/`type`) from the active entry, closing the desync where banner and probes used a stale flat endpoint (e.g. `localhost:1234` while `opencode-go` was active); `reasoning_effort` is normalized and the reasoning strategy refreshed on provider swap; assistant `tool_calls` are kept paired with their tool results.

## [2.11.0] - 2026-09-28

### Added

- **Plan contracts for small models: `plan_step` tool + per-step `checks`** (`src/modules/execution/plan-tool.ts`, `plan-actions.ts`, `plan-checks.ts`, `planner.ts`, `plan-steps.ts`, `module.ts`): `plan create`/`re-plan` now require `checks` 1:1 with steps (`file-exists:<path>` hard-verified on done via `StepVerifier`, `command:<cmd>`/`manual:<text>` self-certified with an explicit note; delete-kind inverts the file check). New alwaysOn tool `plan_step step=N status=done|failed|skipped` replaces `plan update step=` for status changes (no `action` parameter to confuse; old form keeps working as an alias) and is wired everywhere `plan`/`todo` are (alignment exemption, stuck-detector read-only set, bookkeeping key, terminal checklist refresh, web plan snapshot, meta-color sets). `plan` coverage validation is now a hard block (`plan.coverage_blocked`, validated before any state mutation so a rejected create leaks no active plan). `kinds` removed from the model-facing schema — create/delete intent is fully auto-detected (`switchStepKind` both directions: verified deletions flip to delete, never-deleted-missing files flip back to create). `todo done` accepts `ids=[...]` (list/add print `[id]`); text matching stays as fallback. Step checks render as `↳ check:` in the prompt block; system prompt and all model-facing `plan update` directives now teach `plan_step`; i18n en+ru (`plan.checks_*`, `plan.check_failed`, `plan.check_self_certified`, `plan.coverage_blocked`, `plan.step_required`, `todo.subtask_id_not_found`).

- **Memory-aware `question` tool in the core set** (`src/tools/question.ts`, `src/tools/index.ts`, `src/core/system-prompt.ts`, `src/i18n/en.json`, `src/i18n/ru.json`): single/multi-choice and free-text prompts now registered in `registerAllTools()` (visible in REPL and web UI; `approve` registered alongside for explicit Yes/No — reject returns `success:false` so the loop treats it as a failure signal). The handler pre-checks agent memory itself (`splitByMemory` over `MemoryStore.search`, fail-open) — questions memory already answers are reported, not asked; answers live only in the session (persist via `remember` only when asked to); at most `MAX_QUESTIONS_PER_CALL = 3` unknown questions per call with a re-call note. System prompt carries a one-line `ASK RULE`; REPL rendering already matched `STYLE.md`, web rendering reuses `feed.js onQuestion`.

- **Activity rail above the composer** (`src/modules/webui/assets/js/rail.js`, `index.html`, `styles.css`, `app.js`, `tabs.js`, `settings.js`): an indicator that lives for the whole turn — indeterminate scanner with phase/elapsed/tool & event counters when no plan exists, honest `done/total` progress with step ticks when an MoE plan is active, and a short flash on every real SSE event (`tool_start`/`tool_end`/`text`/`plan`). Layouts `off|line|meta|full` via the new config key `ui.activityRail` (default `line`), editable in `/config` and web Settings → Chat output and applied live; en/ru localized, `prefers-reduced-motion` respected, phase announced politely (`role="status"`, timer/counters `aria-hidden`). Spec: `docs/specs/2026-09-27-activity-rail-design.md`.

- **Web chat font size** (`src/config/types.ts`, `defaults.ts`, `registry-extra.ts`, `src/modules/webui/assets/styles.css`, `assets/js/settings.js`, `app.js`, `src/i18n/en.json`, `ru.json`): new `ui.fontSize` key (`compact` = 13px / `comfortable` = 15px / `large` = 17px, default `comfortable`), editable via `/config`, `mma config set` and web Settings → Chat output; applied live through `body[data-font]` without a reload (unknown values fall back to the default). Web-only — the terminal is unaffected.

- **Composer selector switches with loaders + 4th reasoning selector** (`src/modules/webui/reasoning-view.ts`, `config-api.ts`, `assets/js/settings.js`, `store.js`, `index.html`, `styles.css`, `src/i18n/en.json`, `ru.json`): switching provider/model/context/reasoning now paints a pending mark (`⋯` + `aria-busy`, all selector menus inert) from click until config + model list are re-read (provider/model re-reads run in parallel; context/reasoning skip the model round-trip), with single-flight (double-click answers `web.selectors.switch_busy`) and a stale-guard so a slow A→B→A never repaints over the fresh state; boot shows the same mark instead of bare `—`. `GET /api/models` additively carries `reasoning: {strategy, supported, mode}` (strategy from the active provider preset via entries, `supported` from the probe cache, `null` until probed), rendered as a 4th row showing only supported levels (`openai-effort` → full set, `prompt-tag`/`template-kwarg` → coarse set without `medium`/`max`); `strategy: "none"` hides the row, a failed probe shows an honest `off` mark with a shortcut to Settings → Reasoning. Spec: `docs/specs/2026-09-28-web-selector-loaders-reasoning-design.md`.

### Changed

- **Internal loop diagnostics are verbose-only** (`src/logger/app-logger.ts`, `src/output/channel.ts`, `src/cli/main.ts`, `src/cli/repl-commands.ts`): new `Logger.diagnostic(level, msg, meta)` marks loop internals (hallucination retries, audit/compaction notes, repeated-tool nudges, MoE/critic internals, `LLM warning`) with `data.diagnostic` on the output bus. `OutputChannel.setShowDiagnostics()` drops them unless `ui.verbosity === "verbose"`, so chat shows user-facing notices only; file logging (`.log`, `app.jsonl`) is unchanged and diagnostics stay diagnosable. `/config ui.verbosity` now also hides `info` logs outside verbose, matching the startup rule.
- **Critic verdict no longer renders in chat** (`src/core/agent/critic-gate.ts`, `src/ui/renderer.ts`, `src/modules/webui/forward.ts`, `assets/app.js`, `assets/js/feed.js`): `Renderer.criticVerdict`, the SSE `critic` event, the `onCritic` UI callback and the `ui.critic_*`/`web.critic_*` i18n keys are removed. The verdict remains in `session.jsonl` (`critic_check`/`critic_verdict`/`critic_escalation`) and as a verbose diagnostic line; model-facing repair/advice still goes through `<system-summary>` only.
- **Hallucination uncertainty line follows the same rule** (`src/core/agent/hallucination-gate.ts`): the `[⚠️ Uncertainty]` meta line is rendered only in verbose mode; the model still receives the retry context.
- **Web quiet hides model-facing tool bodies** (`src/core/types.ts`, `src/core/agent/tool-batch.ts`, `src/modules/webui/forward.ts`, `run-agent.ts`, `assets/app.js`, `assets/js/feed.js`, `src/tools/question.ts`): `onMeta` carries an optional `MetaKind` (`tool` for display/output/diff/failure-gist from `ToolBatch`, `status` otherwise); the SSE `meta` event tags tool bodies with `kind: "tool"` (status events stay wire-identical) and `feed.js onMeta` drops them in `quiet`, mirroring the terminal renderer. `question` returns `display: ""` so its model directives (memory/session/batch rules) never echo — the model still gets the full `output` in `role:"tool"`. Plan/file/question cards and the single `↳` failure cause are unaffected. Spec: `docs/specs/2026-09-28-web-quiet-tool-meta-design.md`.
- **System prompt routes questions through tools, not plain text** (`src/core/system-prompt.ts`, `src/tools/question.ts`): observed in `ses_mukw2cxn` — the model asked a choice question as a chat dash-list instead of calling `question`, so no interactive buttons appeared. `SCOPE`/`STOP AND ASK` now mandate the `question` tool (options when variants are known), `PROTECTED PATHS` mandates `approve`; plain text remains only as a headless fallback. The `question` description itself now forbids plain-text choice lists.
- **Web default font size 13px → 15px** (`src/modules/webui/assets/styles.css`): the `body` base size moves to the new `comfortable` step; `compact` restores the old 13px via `body[data-font]`.

## [2.10.0] - 2026-09-27

### Added

- **Config registry expansion** (`src/config/registry.ts`, `src/config/registry-extra.ts`): ~110 keys now editable via `/config`, `mma config set` and web Settings; new value types `json` (objects, 20K limit, `JSON.parse`) and `list` (string arrays, comma-separated in REPL). `registry.ts` stays frozen (grandfathered over 300 lines) — new defs live in `registry-extra.ts`, merged into `DEFINITIONS` by concat.
- **`mma config set` validation + `--force`** (`src/cli/commands.ts`): writes go through `setConfigValue` by default (bad value → `cli.config_invalid`, nothing persisted); `--force` is a raw dotted-path escape hatch without validation.
- **`/security status` (REPL + web)** (`src/cli/repl-commands.ts`, `src/modules/webui/commands-settings.ts`): read-only summary (`security · on/off`, `↳` lines per STYLE.md) plus `/security <key> [value]` registry writes; handler maps per rule #17, automatic in web `/api/commands` HELP.
- **Provider form fields** (`src/modules/webui/providers-api.ts`): `maxCompletionTokens` (512–128000), `cache` (mechanism/report selects + 6 bool flags), `retry{maxRetries,baseDelay,maxDelay}`; mirrored to legacy when active, validation failure keeps the existing `400 invalid-provider`.
- **Web MCP CRUD** (`src/modules/webui/settings-api.ts`, `server.ts` route table): `POST /api/mcp` (create) + `PUT /api/mcp/:id` (full edit, `stdio→command` / `sse|http→url` required), `restartRequired: true`.
- **Web LSP read/edit** (`src/modules/webui/settings-api.ts`): `GET /api/lsp` table + `PUT /api/lsp/:lang` (`enabled/timeout/command/args` only; add/remove stays JSON-only), `restartRequired: true`.
- **Generic web settings controls** (`src/modules/webui/assets/js/settings-controls.js`): `controlFor` renders bool/enum/int/share/list/json per registry type.
- **Settings information architecture** (`src/modules/webui/assets/js/settings-controls.js`, `index.html`, `settings.js`): `PANEL_SECTIONS` is the single source of truth mapping each panel to *named* sections, so a section title always describes the keys under it and no key sits in an "Advanced" bucket. Sidebar grew to 14 intent-named sections (network/browser/sessions split out; `advanced` keeps only diagnostics/retry/service), each panel renders titled cards with a one-line explanation, and the per-group count badges are gone.
- **Settings search** (`src/modules/webui/assets/js/settings.js`, `index.html`, `styles.css`): a search box over the same `PANEL_SECTIONS` table plus i18n labels; results show label + owning panel + dotted key, selection switches the panel and flashes the row (`Esc` clears).
- **Structured editors for list/JSON keys** (`src/config/registry.ts` `ConfigKeyDef.editor`, `src/config/registry-extra.ts`, `src/modules/webui/assets/js/settings-controls.js`): registry metadata now tells the GUI how to render a value. `tags` = removable chips with an inline adder (bash/path/network rule lists, `tools.defaultTags`, `contentScan.dangerousPatterns`), `checkboxes` = multiselect over a fixed set (`auditNotifier.eventTypes`), `table` = typed record rows (`pricing.overrides`, `experts`, `modelCapabilities`). Tables validate the record client-side and never post a half-filled row; editors post JSON, and `parseConfigValue` accepts a JSON array for `list` keys so values containing commas (regexes like `a{1,3}`) survive.
- **Memory add dialog** (`src/modules/webui/assets/js/settings.js`): adding a memory entry uses the shared nested dialog (category + multi-line note) instead of the cramped inline row.

### Changed

- **Provider upsert semantics** (`src/modules/webui/providers-api.ts`): a create-POST naming the only entry of a virgin legacy config updates it in place instead of `409 name-conflict`; genuine collisions in multi-entry configs still return `name-conflict`.
- **One nested settings dialog** (`src/modules/webui/assets/js/settings.js`, `index.html`, `styles.css`): provider, MCP-server and LSP-server edits all open in the shared `#subOverlay` (`openSubDialog`/`closeSubDialog`) above the settings modal, with focus trap, focus return and Esc/backdrop close; the inline MCP/LSP forms and the provider-only overlay are gone.

### Fixed

- **Audit event checkboxes** (`src/modules/webui/assets/styles.css`, `src/i18n/*.json`): `.row input` (a right-aligned 120px field) was inherited by checkboxes, so the label drifted away from the box; checkboxes now reset width/alignment and lay out in an even grid, and every option has a human label (`security block`, `bash command`, …) instead of a raw id.
- **Settings reported a stale MMA version** (`src/config/registry.ts`): the `version` key returned `config.version` — the config-schema version written at first launch (`2.0.0`), which never matched a release. It now reports the installed package version (`readMmaVersion()`, read at call time), so the web Settings panel and `/config version` show the real release; the description no longer claims "(read-only)".

## [2.9.0] - 2026-09-26

### Added

- **`process_wait` tool** (`src/tools/bash.ts`, wired into `manage_hint`, `bash`/`process_log` descriptions and the hidden-tool redirect list): a single blocking wait on a background process (`id`/`timeoutMs`/`tail`) that returns the buffered tail when it exits — replaces `process_log` polling loops and `ping`/`sleep` delays.
- **Result memoization** (`src/tools/executor.ts`, `src/tools/bash.ts`): read-only tools (`read_file`/`list_dir`/`glob`/`grep`/`file_info`) plus single, read-only bash commands are cached per session (120s TTL), wiped by any mutation. Repeats of the same read no longer re-execute.
- **Success-claim check** (`src/modules/hallucination/success-claim.ts`, wired into `src/core/agent/hallucination-gate.ts`): a strong completion claim ("done"/"published") together with error signals in the last 10 tool outputs and no hedging triggers one bounded re-check (`MAX_CLAIM_CHECK_RETRIES = 1`, `hall.claim_contradiction`), then fails open — never a block. Deterministic (regex + tool success flags, no LLM), Cyrillic-aware.
- **`session export --compact`** (`src/cli/commands.ts`, `src/modules/session/export.ts`): human-readable export without tool-result dumps.

### Fixed

- **repeats made visible**: `getStuckReason` now surfaces repetitive calls (previously a warning key with no logged reason); `process_log` poll loops point at `process_wait`; the quiet renderer folds consecutive identical action lines into a single `xN` line.
- **web think-toggle alignment** (`src/modules/webui/assets/styles.css`, web `action.hide/show` i18n): dropped the `▾`/`▸` glyphs from the toggle labels in favor of an inline-flex SVG slot, fixing the alignment.

## [2.8.0] - 2026-09-26

### Added

- **Provider context auto-detect** (`src/llm/provider-context.ts`, `src/llm/models-dev.ts`, `src/core/bootstrap.ts`, `src/core/agent.ts`): MMA now asks the active backend for the context window it actually serves and adopts it as the effective `contextWindow` (provider wins over config, in-memory only). Probe chain: LM Studio native (loaded instance, not card maximum) → Ollama native (`/api/ps` → `/api/show`) → llama.cpp `/props` (`n_ctx`) → OpenAI-compat `/models` metadata (`context_length`, vLLM `max_model_len`, OpenRouter `top_provider.context_length`) → models.dev catalog (last resort for OpenCode Zen/Go, whose own `/models` returns bare ids; slim `id → context` disk cache `~/.mma/models-dev-cache.json`, 24h TTL, fail-open). Applied at startup via `applyProbedContext` (late `agent.reconfigure` so budgets follow; skipped on manual override or after a turn ran) and in `Agent.reconfigure` on model/provider switches. `HostStateSnapshot.contextWindow` + `renderState` keep the web topbar in sync.
- **Active provider endpoint resolution** (`src/modules/providers/manager.ts`): new `activeProviderEndpoint()` resolves `{baseUrl, apiKey, type}` from `provider.active` in `entries` (fallback: legacy flat fields). The context probe, model autoload and reasoning-probe cache key used the stale flat fields after `/provider use` (observed: flat `localhost:1234` while `opencode-go` was active, so Zen was never probed).
- **LM Studio as a first-class provider** (`src/modules/providers/presets.ts`): new `lmstudio` builtin type (fixed `http://localhost:1234/v1` URL, no key, model list, local prompt-cache) on the same OpenAI-compatible transport, so native discovery travels with it instead of hiding inside a generic `openai-compat` entry. Wired everywhere a type matters: terminal/web setup wizards (port scan + `not-needed` key), web provider form presets and type suggestions, `mma provider add lmstudio`. The old `openai-compat`-typed local preset is retired (existing entries keep working).

## [2.7.0] - 2026-09-25

### Added

- **web streaming Markdown** (`src/modules/webui/assets/md.js`, `smd.js`): chat answers are now parsed incrementally by a vendored `streaming-markdown` (MIT) and rendered as real Markdown — headings, paragraphs, lists, task lists, blockquotes, rules, tables, links, images, inline code, bold/italic/strikethrough. Incremental block rendering replaces the old full re-render per chunk (O(n²)); half-open inline constructs (`**bo`) resolve without flicker.
- **syntax highlighting** (`src/modules/webui/assets/hljs.js`, `styles.css`): fenced code blocks are highlighted once, when the fence closes, with a vendored highlight.js (common build, MIT); token palette reuses the theme's semantic colors in dark and light.
- **code block chrome** (`md.js`): every fence gets a dim header with its lowercase language label and a copy button (`navigator.clipboard` with an `execCommand` fallback), enabled only once the block is complete; success shows `✓`.
- **per-message copy** (`app.js`): each assistant message/turn gets `copy` and `copy as markdown` actions. New i18n keys `web.code.copy/copied/copy_failed`, `web.msg.copy/copy_md` (en+ru).
- **new web assets/routes**: `/md.js`, `/smd.js`, `/hljs.js` (`WebUiAssets.mdJs/smdJs/hljsJs`, `STATIC_ASSETS`); `index.html` loads `hljs.js` (defer) and boots `app.js` as an ES module.
- **web settings — model/provider panel redesign** (`src/modules/webui/assets/app.js`, `styles.css`): the panel is split into titled sections **Model** (search + scrollable catalog, active marked) and **Providers** (add button in the section header, one entry per provider with an active badge, metadata line and `make active`/`edit`/`delete` chips). The duplicate "active provider" row is gone; the add/edit form opens inline with required fields first and optional context/priority/rpm/parallel collapsed under "advanced", plus type/base-URL suggestions. New i18n keys `web.settings.section_models/section_providers/provider_add_title/provider_edit_title/provider_advanced/provider_make_active/providers_empty` (en+ru). Design: `docs/specs/2026-09-25-webui-provider-settings-design.md`.
- **per-provider model memory** (`src/config/registry.ts`, `src/config/types.ts`): the model you last used with a provider is stored in `provider.models[name]` (written on every `model` change) and restored when you switch back via `provider.active` — the global `config.model` no longer silently carries over a model the new backend does not serve. Additive config field, no migration.
- **provider name guard** (`src/modules/providers/naming.ts`, `src/modules/webui/providers-api.ts`, CLI add): a new/renamed provider must not collide with another entry's `label` or `type`; conflicts are rejected (`409 name-conflict`, `cli.provider_name_conflict`) instead of silently editing the wrong entry. Web edits send `originalName` so an entry can keep its own name.
- **one-click provider presets in the settings form** (`src/modules/webui/providers-api.ts`, `assets/app.js`): `GET /api/providers` now returns `presets` (the builtin providers with their fixed base URLs, plus named local endpoints **LM Studio / Ollama / vLLM** that map to `openai-compat` with their well-known URLs) and the add/edit form shows a **preset** select that fills `type`, `label` and `baseUrl` in one click — neither hosted nor local providers require typing a URL by hand. New i18n keys `web.settings.provider_preset/provider_custom` (en+ru).
- **provider add/edit as a nested dialog** (`assets/index.html`, `app.js`, `styles.css`): adding or editing a provider now opens its own dialog **above the settings modal** (`#providerOverlay`, header + form, Esc / backdrop / ✕ to close, Tab focus-trap) instead of an inline block that was crammed into the panel; the form got roomier vertical spacing.

### Changed

- **`app.js`** is now an ES module importing `./md.js`; `renderAssistantText` and the live `text` stream share one renderer, and `parseFences`/`renderTextSegment` are removed.
- **`feedHasContent`** now recognizes `.md` blocks.
- **web assets are served fresh per request** (`src/modules/webui/state.ts`, `module.ts`, `server.ts`): editing `src/modules/webui/assets/*` is now visible in the browser without restarting `mma web` (`WebUiState.assetSource` re-reads them on each static request; server `src/**/*.ts` changes still need a restart).

### Fixed

- **model list now follows the active provider** (`src/modules/webui/module.ts`): the web model cache was built once at startup and never refreshed, so after switching provider the settings/selector still showed the previous provider's models. It is refreshed on every `reconfigure` (`makeReconfigure(..., after)`), so `/api/models` reflects the newly active provider.
- **adding a provider no longer drops the legacy config** (`src/modules/webui/providers-api.ts`): on a legacy single-provider config (`provider.type`/`baseUrl` without `entries`) the first add used to create `entries` from scratch and switch `active`, replacing the working provider. The legacy entry is now seeded into `entries[0]` and stays active.
- **project map ignores dev-only dirs/files** (`src/modules/indexer/walker.ts`): the walker now skips `_testing`, `.superpowers`, `.opencode`, `.fallow` (mirroring `.gitignore`), lockfiles (`package-lock.json`, `bun.lock`, `yarn.lock`, …), `.fallow*` files and vendored/minified bundles (`hljs.js`, `smd.js`, `*.min.js`). A dev checkout's map is no longer flooded (this repo: 860 → 774 files); the same filter now also gates the FS watcher.
- **removed a stray committed session export** (`session-ses_fdd1.md` at the repo root) and `.gitignore` now ignores `session-*.md`.

## [2.6.0] - 2026-09-25

### Added

- **web first-run setup wizard** (`src/modules/setup/{answers,apply,discovery}.ts`, `src/modules/webui/setup-api.ts`, `assets/setup.js`): `mma web` with a virgin config now opens a browser wizard (Language → Provider → API key → Model → Context → Security → Review) instead of booting on defaults. The terminal wizard (`src/cli/setup.ts`, `setup-order.ts`) re-exports the same shared core, so both frontends use one write path.
- **web setup API**: `GET /api/setup` (`required` + languages/providers/defaults), `POST /api/setup/{scan,models,test,locale}`, and `POST /api/setup` (validate → apply → persist → reconfigure → ungate). Emits an SSE `setup_done`.
- **web chat gating**: while `setupRequired`, `POST /api/message` and `/api/command` answer `409 setup_required` — server-enforced, not just hidden in the UI. A configured instance refuses a second `POST /api/setup` with `409 already_configured`.
- **web setup UI**: hidden full-screen `#setupGate` + `setup.js` (`window.MmaSetup.maybeOpen()`), `app.js` runs the wizard before chat boot, localized `web.setup.*` keys (en+ru), styles per `docs/design/ui/STYLE.md`.
- **system-prompt completion criteria** (`src/core/bootstrap.ts`): `buildSystemInfo` now carries a `DONE CONDITIONS` section (all plan steps done, artifacts exist with real content, runnable verification reports clean, then a short summary) and a `STOP AND ASK THE USER` section (ambiguity, unfound path, destructive action, stuck after 2+ approaches) — explicit stop/ask criteria for small models.
- **stuck failure classification** (`src/modules/execution/stuck-detector.ts`, `execution-plugin.ts`): `StuckDetector.classifyFailure()` maps the live stuck states to a stable `FailureType` (`timeout`/`repeat`/`error_loop`/`bash_flailing`/`read_only`) and `getStuckDiagnostic()` emits a compact `[STUCK: type=…, tool=…, count=…, iteration=…]` marker, now prefixed to the recovery `<system-summary>` so the model sees a machine-readable reason before the guidance.
- **session auto-naming** (`src/modules/session/auto-name.ts`, `src/core/agent.ts`): every session gets a deterministic name derived from the first user message, then an optional background LLM refinement (config `session.autoName`, 8s timeout, fail-open). `SessionMeta.nameSource` tracks provenance (`default`/`auto`/`manual`) and a manual rename is never overwritten.
- **counter-agent (in-loop critic)** (`src/modules/critic/`, `src/core/agent/critic-gate.ts`): an evidence-grounded, event-triggered LLM verifier wired into the single-agent loop next to the audit/hallucination gates. It runs on work mutations and before finish, advises on `concern`, performs a bounded repair on `critical` (deduped, capped by `critic.maxCalls`/`maxRepairCycles`), and fails open on error/timeout/parse failure. Verdicts are logged to `session.jsonl` (`critic_check`/`critic_verdict`/`critic_escalation`) and shown as one chat line at `ui.verbosity ≥ normal` (terminal `Renderer.criticVerdict`, web SSE `critic`; hidden in `quiet`, summary in `verbose`). Config lives in the new `critic` domain. The MoE path is untouched.
- **MoE + critic settings** (`src/config/registry.ts`, `src/modules/webui/assets/app.js`): `moe.enabled`, `moe.maxReplanCycles`, `critic.enabled`, `critic.maxCalls`, `critic.maxRepairCycles`, `critic.timeoutMs` are now settable via `/config` and a dedicated web settings **Agent** panel. The web session tab and sessions dropdown now pick up a rename immediately instead of waiting for the 15s session-list poll.

### Changed

- **`mma web` virgin notice** (`src/cli/web-command.ts`): prints `cli.web_setup_required` (browser wizard opens) instead of the one-shot defaults warning.

### Fixed

- **stale project-map cache** (`src/modules/indexer/cache.ts`, `walker.ts`): `index-cache.json` is now an envelope carrying a schema `version`, the absolute project `root` and a tree `signature` (SHA-1 over sorted `path\0size\0mtimeMs`, computed stat-only by `Indexer.scanSignature()`). `IndexCache.load()` recomputes the signature and rejects a cache whose version/root/signature differ, or a legacy raw-`IndexResult` cache, so a project map that no longer matches the tree can never reach the system prompt — the index is rebuilt instead.
- **reasoning overhead on trivial turns** (`src/config/defaults.ts`, `src/core/agent/reasoning-resolver.ts`): the auto-policy baseline now defaults to `"low"` (was an implicit `"medium"` resolver fallback), and an unset `baseline` falls back to the configured `reasoning.min` (`"low"` by default) instead of a hardcoded `"medium"`. Trivial Q&A turns no longer burn medium reasoning tokens; the policy still raises to `"high"` on hallucinations, audit rejections and plan creation.
- **`WebUiAssets.setupJs`** is optional (lightweight test fixtures stay valid) and `/setup.js` is served with `Cache-Control: no-store` like the other assets.

### Security (audit waves B/C/D/E, severity 4)

- **symlink write escape** (`src/modules/security/path-validator.ts`): `isPathWritable` now runs the `escapesViaSymlink` check the read path always had — and canonicalizes the nearest existing ancestor, so creating a file under a symlinked/junctioned directory that points outside `baseDir` is blocked too. Write/delete/move can no longer escape the sandbox through a link.
- **command injection in lint-on-write** (`src/modules/plugins/builtin/lint-on-write.ts`): `bun build`/`node --check` now spawn with `shell: false` and an argv array instead of interpolating a model-supplied path into a shell string (`$(…)`, backticks, `%VAR%` no longer execute).
- **MCP tool registration race** (`src/modules/mcp/module.ts`): tool discovery is parallel and awaited before the bootstrap snapshots tool definitions (was fire-and-forget, so real MCP tools were never registered); a timed-out attempt is cancelled so its late success cannot register a server already marked failed.

### Fixed (audit waves B/C/D/E, severity 4)

- **unvalidated `plan update` status** (`src/modules/execution/plan-actions.ts`): only `done|failed|skipped` are accepted; an arbitrary status (or `pending`) is rejected (`plan.bad_status`) instead of being persisted as an unknown state that never lets the plan complete or silently reopens a done step.
- **false auto-close of plan steps** (`src/modules/execution/module.ts`): `autoCloseEvidenceSteps` now requires delete-kind targets to be gone and create-kind files to exist with non-empty content, instead of marking empty/undeleted deliverables done and passing the final audit.
- **MoE subagent scope clobber** (`src/tools/subagent.ts`, `src/tools/executor.ts`): the parent scope is read from the shared executor (`getScope`) and restored with compare-and-restore, so parallel subtasks no longer reset isolation to `undefined` (unrestricted).
- **stuck/recovery detection gaps** (`src/modules/execution/execution-plugin.ts`, `stuck-detector.ts`, `moe-executor.ts`): bash-flailing and cross-tool consecutive failures are now injected into recovery and logged (were computed but never surfaced); the pre-plan path preserves loop history (a `reset()` each iteration had disabled read-only/repeat detection without a plan); a type/syntax error on a successful write is no longer cancelled by `recordToolSuccess` on the same call; escalation count survives trivial successes; per-file typecheck failures clear selectively instead of all at once; the MoE retry detector keeps a stable step id so errors accumulate across attempts.
- **secrets in session logs** (`src/core/session-logger.ts`): assistant content, reasoning, `system` and `error` entries are now redacted via `redactContextSecrets` (only `user`/`tool_result` were). Also `logSessionStart` checks for an existing `session_start` through the decrypt-aware store, so it no longer duplicates the entry under session encryption.
- **SSRF via redirects** (`src/modules/security/network-validator.ts`, `tools/{download-file,web-browse,web-fetch}.ts`): new `fetchValidated()` follows redirects manually and re-validates every hop (download/web_browse used default `follow`; web_fetch re-checked only one hop). Expanded/non-canonical IPv6 loopback and IPv4-mapped forms (`0:0:0:0:0:0:0:1`, `::ffff:0:7f00:1`, link-local/unique-local) are now recognized as private.
- **download_file write guards** (`src/tools/download-file.ts`): now honours the onboarding `writePathAllowlist` and the always-on protected-path check, so it can no longer overwrite `.env`/keys that every other write tool refuses.
- **memory tool hardening** (`src/modules/memory/store.ts`, `tools/{remember,recall}.ts`): memory categories are validated against the fixed list (a model-supplied traversal like `../../notes` is rejected) and a failed read/write returns `success:false` instead of a fake success.
- **mcp_call client leak** (`src/tools/mcp-call.ts`): the MCP client is disconnected in a `finally` even when `callTool` throws, so a failed call no longer orphans the stdio child process.
- **plan correctness** (`src/modules/execution/`): MoE selective re-plan with all subtasks already successful returns success instead of a bogus "possible cycle" failure; `verifyMoEManifest` resolves files/typecheck nested-aware (`findExistingFile`/`findTypecheckRoot`); plan-coverage uses an extension allow-list so `e.g`/`i.e` are not "missing files" while real `.css`/`.html` deliverables are checked; read-after-write overlap compares paths (not string prefixes) so `main.ts` vs `main.tsx` no longer conflicts; `applyAutoFixes` no longer mutates the caller's plan; `PlanStore` writes a unique temp file and logs a failed rename (two `mma` processes no longer clobber each other); `StepVerifier` kills the whole process tree on timeout.
- **test audit is evidence-based** (`src/modules/execution/auditor.ts`, `audit-runners.ts`): the final audit runs the tests whenever a test file exists, instead of deciding from step prose keywords (rule #10) — a plan with tests but no "test" wording is no longer approved without running them.
- **tool/robustness hardening (audit sev 2–3)** across `src/tools`, `src/modules` and `src/ui`:
  - `read_file` clamps `offset` (0 no longer returned the last line) and an oversized `limit` (2000 cap); `process_log` clamps `tail` to its documented 300; `pipeline_run` tracks recursion depth on the shared executor and uses a per-invocation engine (no singleton clobber under parallel MoE waves).
  - `syntax-validator` spawns `bun`/`node` without a shell (path injection) and accepts JSONC (comments/trailing commas) so a valid `tsconfig.json` is no longer rejected.
  - command validator skips wrapper options (`nice`/`timeout`/`stdbuf`/`sudo …`) and versioned interpreters (`python3.11 -c`) — `nice rm file` no longer evades the blacklist.
  - skills loader normalizes CRLF, so Windows-checkout skills load instead of silently disappearing; process registry caps a newline-less partial line; MCP stdio request ids are monotonic; plugin loader survives an unreadable entry; lint-on-write typecheck debounce is keyed by project root (monorepo writes no longer leak another project's errors).
  - `mma provider use` persists the switch for multi-entry configs; line-editor completion drops the stale absolute frame anchor (candidate list no longer erased on DSR terminals); md-formatter flushes a pending table before a code fence.
  - removed the dead `tools/scope-check.ts` duplicate (test now targets the real `security/path-validator`); `isInsideDir` no longer rejects names beginning with `..`.
  - MCP reliability: sanitized tool-name collisions are disambiguated (was a bootstrap crash) and the prompt advertises the same sanitized `connect` name; concurrent SSE calls use a per-id pending map instead of one shared slot (no cross-talk / wrong response).
  - removed the dead `PlanPersister` module; `PluginManager.runOnBeforeTool` now honours the string-return block contract like the tool executor.
  - i18n: verifier typecheck/test messages, subagent/pipeline/mcp_call/chunk_query/meet_done tool output, plan summaries/test-run summaries and CLI status/metric lines now go through `t()` (en+ru), so RU sessions no longer mix English fragments.
  - `read_file` no longer counts a phantom trailing line; sessions older than 30 days are actually archived (`rotateOldSessions` was dead code — now scheduled non-blocking at bootstrap); the UI locale is resolved before `createProgram()` so `--help`/typo hints respect `locale`; non-TTY `LineEditor` carries partial chunks instead of splitting them; `killTree` is asynchronous (no event-loop stall on Windows shutdown).

## [2.5.0] - 2026-09-24

### Added

- **web file viewer** (`src/modules/webui/file-api.ts`): `GET /api/file?path=<p>` serves a workspace text file for the chat file cards' Open link — resolved against the workspace (lexical + `realpath` guards, so symlinks/junctions cannot escape), protected paths (`.git/`, `.env*`, keys) refused, 512 KB cap, binary refused. UTF-16 LE/BE BOM and UTF-8 BOM are decoded; errors are human-readable `text/plain` (the endpoint opens as a browser tab).
- **web cookie auth** (`src/modules/webui/util.ts`, `server.ts`): authenticated requests set an `HttpOnly; SameSite=Strict` `mma_web_auth` cookie and `checkAuth` accepts it, so a plain `<a target="_blank">` navigation authenticates without the token in the URL.
- **web session persistence** (`assets/app.js`): the active session is mirrored into `?session=` (`history.replaceState`, token preserved) and restored on reload after the first state refresh.

### Fixed

- **web reasoning text** (`src/modules/webui/forward.ts`, `history-api.ts`): ANSI escape sequences (`ESC[2m…`) are stripped from streamed/replayed text, meta and tool output — reasoning no longer renders as literal `\u001b[2m…` garbage on the model's own words.
- **web file card** (`assets/app.js`, `styles.css`): the card stacks vertically (path on its own line) and its `open` control is a real `<a target="_blank">` link that opens the file in a new tab.

### Changed

- **dedicated reasoning channel** (`src/core/agent.ts`, `src/modules/webui/forward.ts`, `src/cli/repl.ts`, `src/cli/main.ts`): model reasoning now travels on its own `onReasoning` callback and SSE `reasoning` event (no longer pre-dimmed and no longer mixed into the generic `meta` channel); the terminal renders it via `renderer.reasoning`.
- **web reasoning collapsed by default** (`assets/app.js`): `thinking` blocks (live and replayed) start collapsed; generic `meta` (status, context stats, compaction, tool summaries, warnings) renders as always-visible `.metaln` lines instead of being folded into the reasoning block.

## [2.4.0] - 2026-09-24

### Added

- **web UI chrome icons**: topbar, session tabs/dropdown, settings modal, attach button, chevrons and delete/close controls use inlined [Lucide](https://lucide.dev) SVGs (MIT) instead of emoji/gear glyphs. Chat status glyphs (`◇ ✓ ✗ ✦ ⟡ …`) stay textual per `docs/design/ui/STYLE.md`.
- **web accessibility**: real `<button>`/`role="switch"`/tablist/`role="log"` semantics, `aria-label`/`aria-expanded`/`aria-checked`/`aria-selected`, `:focus-visible` outlines, arrow-key navigation in the settings tablist, a Tab focus trap in the dialog, and `prefers-reduced-motion` handling. Question options, toggles and menu rows are keyboard-operable; the settings modal moves focus in/out.
- **web context probe** (`src/modules/webui/module.ts`, `src/core/host.ts`): the LM Studio loaded-context probe is surfaced as a real sidebar "probe" cell (`{actual} loaded`, warns when below the configured window) instead of a dead `—`.
- **web question parity** (`src/modules/webui/assets/app.js`, `prompt-io.ts`): multi-select hint, and an "own answer…" choice entry mapped to `CUSTOM_INDEX` so `allowCustom` works in the browser (follow-up free-text prompt), matching the terminal.
- **web busy feedback**: the composer reflects `aria-busy`/dim state during a turn, and Enter while busy shows a hint instead of silently dropping the message; Enter is IME-safe (`isComposing`).
- **web session delete guard** (`assets/app.js`): deleting a session is a two-step action (arm → confirm within 3s) instead of an instant destructive click.
- **web context size**: a custom context window is entered inline in the selector menu (focusable number field + save) instead of a native `window.prompt`.
- **web screen-reader status**: a polite live region announces turn end and warnings/errors.
- **web favicon**: a data-URI icon stops the `/favicon.ico` 404 console error.
- **web composer** (`assets/index.html`, `app.js`, `styles.css`): attach + textarea + send share one bordered input surface (controls integrated into the field, focus ring on the group); the send button (`arrow-up`) becomes stop (`square`) during a turn; the textarea auto-grows up to ~200px; selector chips use Lucide chevrons; the `Esc — stop` hint shows only while a turn is running (`web.input.send`/`web.input.stop`).

### Changed

- **web light theme** (`assets/styles.css`): the palette is rebuilt from a single token source. All tokens are defined for both themes (no `-const` duplicates); light-theme `dim`, `cmdout`, success/warn/cyan/think and checker colors now meet text contrast (was ~1.8–2.8:1).
- **web SSE session routing** (`state.ts`, `module.ts`, `assets/app.js`): `broadcast` stamps `activeSessionId` on every event, and the client routes streamed text/tool/plan output to the originating session tab instead of whichever tab is foregrounded.
- **web sidebar polling** (`assets/app.js`): plan/usage re-render is skipped when the `/api/state` snapshot is unchanged, so a 2s poll no longer resets the plan scroll position.

### Fixed

- **web i18n leaks** (`assets/app.js`, `src/i18n`): reasoning hide/show toggle, turn metric ("tools"), usage/metric labels, start banner and `<html lang>` are localized; `attach` hint drops the emoji; added `web.usage.*`, `web.turn.tools`, `web.start.*`, `web.question.*`, `web.input.busy`.
- **web custom answers** (`prompt-io.ts`): `toIndexes` preserves `CUSTOM_INDEX` (`-1`); previously the custom entry was filtered out, so choose-your-own answers were impossible in the browser.
- **web empty-state hint** no longer hardcodes a dark-only color.
- **web horizontal overflow** (`assets/styles.css`): long unbreakable content (user text, file paths, URLs, tool args, command output) now wraps or ellipsizes instead of pushing the feed; `#msgs` clips horizontal overflow. The model/provider/session dropdowns are width-clamped with ellipsized labels, so long names can no longer widen the page and shove the sidebar off-screen. The light-theme input border was softened (was solid green, looked permanently focused). A Chromium smoke test guards all of this at 1440/1000/820px.
- **web tabs** (`assets/styles.css`): tab height now matches the topbar icon buttons (24px, scrollbar padding dropped); the session name ellipsizes with `min-width:0` so the short id and close button always stay inside the tab.
- **web session delete** (`assets/app.js`, `assets/styles.css`): the two-step confirmation no longer resets every 2s (armed id lives in app state, not the rebuilt DOM row); failures show an inline message in the dropdown (the old `#saveIndicator` is modal-only and invisible); deleting the active session is guarded with a clear message instead of a silent `409`; the delete button lost its default UA border/background (was a bordered square). A Chromium smoke test covers the arm → delete and the active-session guard.

### Removed

- **web dead assets**: unused mockup i18n keys (`web.settings.font_size`/`sidebar_default`/`stream_partials`/`add_entry`/`provider_label`/`add_provider_hint`/`pending`) and the obsolete `.edit` CSS selectors; remaining latent `t()` shadowing in `app.js` renamed.

## [2.3.0] - 2026-09-23

### Added

- **web mode parity** (`src/modules/webui/`): the browser UI is rebuilt to match the canonical mockup — topbar with `+`/`☰`/session tabs/`⚙`, chat feed (start banner, user blocks, colored `◇` tool lines, `↳` details, `⟡` metrics, `✦` reasoning toggle, plan/file/link/image cards, `/command` output), model/provider/context selectors, independently collapsible sidebar (scrollable plan + session·usage), and a wide settings modal (General / Model / Context / Reasoning / UI / Memory / Skills / Plugins·MCP / Security / Advanced) with dark/light/auto theme.
- **web REST** (`config-api.ts`, `settings-api.ts`, `sessions-api.ts`, `history-api.ts`): `GET/POST /api/config`, `GET /api/models`, `GET /api/memory` + `POST` + `DELETE /api/memory/:category/:n`, `GET /api/skills`, `GET /api/plugins`, `GET/POST /api/sessions`, `POST /api/sessions/activate`, `DELETE /api/sessions/:id`, `GET /api/sessions/:id/history`.
- **web slash commands** (`commands.ts`): `/help`, `/status`, `/config`, `/model`, `/provider`, `/memory` run in the browser via a handler map, streaming output over the SSE `command` event; `/clear` and `/new` are client-side. Terminal-only commands stay out of scope.
- **web slash commands (extended)**: `/reasoning`, `/verbose`, `/context`, `/session list|use`, `/export [md|json|jsonl]` in the browser (same registry/session machinery as the REPL).
- **web questions** (`src/modules/webui/prompt-io.ts`): the `question`/`approve` tools are registered in web mode with a `PromptIO` over SSE (`question` event) + `POST /api/answer`, so the agent can ask the user interactively in the browser; terminal mode keeps them unregistered.
- **web i18n** (`GET /api/i18n`, `web.*` keys): the browser chrome is localized and switches live when `locale` changes.
- **web resilience**: SSE reconnect with state resync; `Cache-Control: no-store` on static assets (no stale UI after restart).
- **fix**: `--no-agents-md` is now honored on all paths (commander exposes the negatable option as `agentsMd`).
- **web settings polish**: responsive settings modal and adaptive layout; localized config labels and enum values (`config.key.*`/`config.enum.*`); read-only `version`; real Security toggles (`security.enabled`, `security.paths.enabled`, `security.contentScan.enabled`, `security.sessionEncryption.enabled`) + masked web token; provider add/edit (`GET/POST /api/providers`, `DELETE /api/providers/:name`); MCP enable/disable (`POST /api/mcp/:id`); clearer Memory page.
- **web live data**: real usage metrics in the sidebar, clipped tool output in `tool_end`, plan card, image attachments (paste/drag/file, ≤3 × ≤6MB), and new-session creation from `+`.

## [2.2.0] - 2026-09-23

### Added

- **web mode** (`src/cli/web-command.ts`, `src/modules/webui/`): `mma web [--port N] [--host H] [--token T] [--no-open]` — browser chat (SSE `GET /events` + REST `GET /api/state`, `POST /api/message`, `POST /api/interrupt`, `POST /api/command`, static `/` `/app.js` `/styles.css`) without a TTY; loopback by default, token required for non-loopback binds, same-origin check on writes, body/client caps; env `MMA_WEBUI_PORT/HOST/TOKEN/OPEN/MAX_CLIENTS`.
- **host seam** (`src/core/host.ts`, `src/core/web-host.ts`): shared `Host` interface extending the plugin-facing `HostBridge` with `executeCommand`/`getState`; `Repl` and `WebHost` are two implementations over one `Agent`, both submitting through the same `runAgent` path.

## [2.1.0] - 2026-09-23

### Added

- **`meet` / «Познакомимся»** (`src/modules/onboarding/`): LLM-driven interview that records the user's usage profile, preferences and facts to global memory (`~/.mma/memory/preferences.json`, `facts.md`), domain-neutral (development, smart home, assistant, …).
- **`agents init`** (`src/modules/onboarding/init.ts`, REPL `/init`): LLM generation/improvement of `AGENTS.md` for any workspace (code, docs, notes, configs); an existing file is improved in place with a diff and confirmation, never blindly replaced.
- **REPL**: `/meet` (alias `/познакомимся`), `/init`, `/memory` (get/set/unset/find/forget), and a post-setup `[Y/n]` meet offer.
- **CLI**: `mma meet`, `mma agents init` interactive entrypoints.
- **Tools**: strict `ToolContext.toolAllowlist` enforced by the executor; `meet_done` sentinel tool; `question` rendering aligned with STYLE.md (`?` glyph, indented options, `>` prompt).
- **Providers**: shared `preflightProvider`/`preflightFromConfig` (cheap `max_tokens=1` chat probe) gating LLM-dependent entry points.

### Changed

- **CLI**: `mma setup` is the preferred name for the provider wizard; `mma init` remains a working **deprecated alias** (prints a hint to use `mma setup`).
- **Agent**: universal positioning reaffirmed — onboarding and prompts are domain-neutral, not code-only.

## [2.0.0] - 2026-09-22

### Added

- **`/config` get/set/reset** (`src/config/registry.ts`, `src/cli/repl-commands.ts`): one settings surface. Keys are literal `config.json` paths (`contextWindow`, `contextBudget.systemPrompt`, `showReasoning`, `reasoning.mode`, `ui.verbosity`, …) with short aliases, tab completion for keys/values, and `/config reset <key>` / `--all` restoring the session-start (boot) snapshot.
- **Session export** (`src/modules/session/export.ts`): `/export` and `mma session export` write `md` (default), `json`, or `jsonl`; default path `~/.mma/exports/`; secrets redacted by default (`--no-redact`); rotated `.jsonl.gz` supported.
- **Tab completion** (`src/cli/completer.ts`): config keys/values, `/provider add` flags, command names for `/help`, session names for `/delete` and `/export`, subcommands with descriptions for `map`/`context`/`lsp`/`reasoning`/`verbose`.
- **`/help <command>`**: per-command usage, aliases and examples.
- **Unified unknown-subcommand errors** across `provider`/`model`/`skill`/`lsp` and config-key suggestions ("did you mean …").

### Changed

- **`/reasoning`** (`src/cli/repl-commands.ts`): with no argument it now shows status (display + effort) instead of toggling; use `/reasoning show|hide` (aliases `on|off`) and `/reasoning level <auto|default|none|low|medium|high|max>`. Setting a level warns that the auto policy is off.
- **`/verbose`**: with no argument it shows the current level instead of toggling; all changes persist.
- **Uniform persistence**: `/provider use`, `/model use`, `/verbose`, `/reasoning` now save `config.json` immediately and print `saved · reset: /config reset <key>`.
- **`/context`**: accepts fractions (`0.1`) and percentages (`10%`); unknown arguments yield a clear error instead of a bogus size error.
- **`/sysprompt`**: default output is token count + block list; the full prompt prints only with `--full`.
- **`/status`**: now a compact one-line summary (model · provider · session · context).
- **`/provider add` usage** documents every flag; flag values are validated.
- **`/config locale`** re-registers commands and completion, so `/help`/usage switch language without a restart.
- **`showReasoning`** overrides `ui.verbosity=quiet` for reasoning lines.

### Removed

- **`use` alias of `/resume`** (ambiguous with `/model use`, `/provider use`); an unknown `/use` now suggests `/resume`.
- **`/reasoning` and `/verbose` bare-argument toggles** (replaced by explicit status behavior).

## [1.7.1] - 2026-09-22

### Changed

- **Default completion token cap** (`src/llm/openai-compat.ts`): `max_tokens` fallback doubled from 4096 to 8192 (`DEFAULT_MAX_COMPLETION_TOKENS`), so long answers are less likely to be cut by the generation limit. Still overridable via `provider.maxCompletionTokens`.

## [1.7.0] - 2026-09-22

### Added

- **Model capability resolution** (`src/modules/providers/capabilities.ts`, `src/config/types.ts`): a single source of truth for a model's `vision`/`tools` abilities, merged from user override (`config.modelCapabilities[model]`) → live native probe (LM Studio `/api/v1/models` `capabilities`, read by `probeModel` in `src/llm/model-loader.ts`) → provider preset. Exposed to tools via the live `ToolContext.capabilities` getter.
- **First-class tool image channel** (`src/tools/types.ts` `ToolResult.images`, `src/core/agent/tool-images.ts`): tools can return images; the agent loop queues them onto the next user message (`queueToolImages`), keeping `role:"tool"` content text-only and portable.

### Fixed

- **Vision misdetection for non-`-vl` models** (`src/tools/browser.ts`): the `qwen3.5-9b`-style models report `vision: true` in LM Studio but the name-based `modelSupportsVision` heuristic returned `false`, so screenshots were silently downgraded to a text notice. Name matching is removed; the browser tool now reads `ctx.capabilities.vision`.
- **Browser screenshots never reached the model** (`src/tools/browser.ts`): screenshots were embedded as base64 text inside the `role:"tool"` output, which backends never decode and the budget truncates. They are now delivered as `image_url` parts; text-only models get the snapshot instead.

### Changed

- **Browser module prompt** (`src/modules/browser/module.ts`): no longer asks the model to self-assess vision support — screenshot delivery is automatic.

## [1.6.0] - 2026-09-22

### Added

- **Tab completion descriptions & navigation** (`src/cli/completer.ts`, `src/ui/line-editor.ts`): completions carry descriptions, file-path completion is registered in the REPL, arrow keys/Tab cycle candidates, Esc restores.
- **`redactConfigSecrets`** (`src/config/redact.ts`): deep secret redaction for config display.

### Fixed

- **Security-paths wizard answer** (`src/cli/setup.ts`, `src/cli/setup-order.ts`): the question was inverted and a no-op; reworded to restrict semantics and `security.paths.enabled` is now applied.
- **First-run wizard suppression** (`src/config/config.ts`, `src/cli/main.ts`): `loadConfig` no longer persists default config on first load; one-shot runs warn instead of silently using defaults.
- **`/wizard` dropped security answers and ignored `provider.entries[]`** (`src/cli/repl-commands.ts`, `src/cli/setup-order.ts`): applies answers centrally and updates the active entry.
- **`mma config show` leaked secrets** (`src/cli/commands.ts`): secrets redacted by default, `--show-secrets` opts out.

### Changed

- **Chat UI: tool-label accent & separators** (`src/ui/theme.ts`, `src/ui/renderer.ts`, `docs/design/ui/STYLE.md`): the action glyph and the localized tool label now share the category color (`toolAccent`), and a dim `·` separates a status label from its content (reasoning label from reasoning text, tool label from arguments) — the rotating status verb no longer blurs into the model's own words. `Ctrl+O` reprint follows the same accent.

## [1.5.0] - 2026-09-21

### Added

- **Canonical chat UI style** (`docs/design/ui/STYLE.md`, mockup `docs/design/ui/mockup-chat-en-ru.html`, linked from AGENTS.md as the single correct style): no boxed panels, one shared glyph set, semantic color roles, quiet-by-default with detail on demand.
- **UI theme module** (`src/ui/theme.ts`): single source for chat glyphs (`◇ ✓ ✗ ⚠ ✦ ? ↵ ↳ │ ▰▱ ⟡ ⟳`), semantic marks and the `Verbosity` type.
- **Chat verbosity levels** (`ui.verbosity`: `quiet | normal | verbose`, default `quiet`): quiet folds each action into a single `◇ label ✓ ms` line, hides tool bodies and only surfaces the first line of a failed action. New `/verbose [level]` REPL command and `--verbose` plumbing; legacy `ui.verbose` still maps to `verbose`.
- **Read-only run summaries** (`src/ui/renderer.ts`): in quiet mode a consecutive run of read-only tools (`read_file`, `grep`, `glob`, web, …) collapses into one `│ N actions ✓ · ms · /verbose` line; mutating/executing tools stay visible.
- **Calm security/protected-path failures** (`src/core/agent/tool-output.ts`, `src/core/agent/tool-batch.ts`, `src/modules/security/protected-paths.ts`): `toolFailureSummary` maps `[SECURITY BLOCKED]` / `[PROTECTED PATH]` refusals to short localized warnings (`⚠`) instead of red walls; raw markers never reach the chat.
- **`Ctrl+O` action reprint** (`src/ui/action-log.ts`, `src/cli/repl.ts`): the last action's label, args, status and full body are kept and reprinted on demand, so quiet mode stays quiet without losing detail.
- **Spinner elapsed time** (`src/ui/spinner.ts`): the busy line shows `· Ns` once a tool runs longer than 3 seconds.
- **Status voice** (`src/ui/renderer.ts`): thinking phases rotate a few short human labels (`thinking` / `working it out` / `considering`, localized) instead of repeating one word.
- **Plan checklist restyle** (`src/ui/plan-view.ts`): `◇ title ▰▱ 1/3` header and `✓ / ◇ / ○ / ✗` step marks, dropping the raw plan id and `[x]` brackets.
- **Category-colored action glyph** (`src/ui/theme.ts`): the single `◇` mark is colored by tool category — recon cyan, mutate magenta, execute blue, meta dim. Per-tool emoji icons are no longer rendered.
- **Human tool arguments** (`src/ui/renderer.ts`): raw JSON is replaced by short phrases — `plan update` → `step 2 → done`, `browser scroll down`, `move_file` → `a → b`, `mcp_call` → `server/tool`, `remember`, `enable_tools`, `glob`/`grep`/`subagent`/`set_thinking`/`verify`/`process_log` and more.
- **Quiet hides structured info logs** (`src/output/channel.ts`): `info`-level log events (`[INFO] [mma] …`) are dropped from the terminal in quiet mode; warn/error and `writeLine` blocks are unaffected.

### Fixed

- **Closing code fence without a trailing newline** (`src/ui/md-formatter.ts`): a final ```` ``` ```` at end of stream was rendered as code content; it now closes the block.
- **Thought duration inside the answer** (`src/ui/renderer.ts`): the thinking block is closed when the final answer or the next tool starts, so `N.Ns` never lands inside the response text.
- **Durations over a second** (`src/ui/theme.ts`): rendered as `1.4s` instead of `1400ms`.

### Changed

- **Tool output never shows system names** (`src/ui/renderer.ts`): tool identifiers (`read_file`, `bash`, …) are lookup keys only — the chat renders the localized `tool.friendly.*` label, with a generic localized fallback when a translation is missing.
- **One action glyph** (`Renderer.toolMarker`): every tool uses `◇` instead of per-category arrows/asterisks.
- **Calm errors** (`src/ui/renderer.ts`, `src/ui/md-formatter.ts`): `✗` for real failures, `⚠` for soft blocks; `ui.error_prefix` is now `✗ ` in both locales.
- **No box-drawing grids** (`src/ui/md-formatter.ts`, `src/ui/table.ts`): code blocks use a dim language label plus a `│` gutter; markdown tables render as a bold header + dim rule + aligned columns.
- **Thinking header and run footer**: `✦ thinking` instead of `→ Thought:`, `⟡ model · provider · ms` instead of `▣`.
- **Answer has no marker prefix** (`src/ui/renderer.ts`): the final answer starts on a fresh line instead of `- …`, so a response that opens with a code block is not mangled.

## [1.4.0] - 2026-09-21

### Added

- **Protected-path confirmation guard** (`src/modules/security/protected-paths.ts`): file-mutating tools (`write_file`, `edit_file`, `delete_file`, `move_file`, `create_dir`) now refuse paths under VCS internals (`.git/`, `.hg/`, `.svn/`) and secret/env files (`.env*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.crt`, `*.secret`, `*.token`, `.npmrc`, `.netrc`, `.git-credentials`, `.gitconfig`) with a directive to ask the user for explicit confirmation. The guard is **always on** (independent of `security.paths.enabled`) and never hard-blocks — the user can still approve. Verified live on `qwen/qwen3.5-9b`: the model recognized the rule from the prompt, refused, and asked the user.
- **System-prompt `PROTECTED PATHS` rule** (`src/core/bootstrap.ts`): the model is told up front not to modify VCS/secret/env paths without explicit user confirmation, and to stop and ask if a tool reports one (no `bash` workarounds).

### Fixed

- **Provenance after transparent provider failover** (`src/core/agent.ts`, `src/core/agent/token-tracker.ts`, `src/core/bootstrap.ts`): after `FallbackProvider` switched to another entry, the footer, cost attribution and `llm_usage` still reported the original provider. `callerProvenance()` now reads the live active entry (`getProviderName`), and `TokenTracker.logUsage` passes `provider`/`model` into `llm_usage`. Verified live: `provider failover: dead -> live` → footer `· live`, `llm_usage.provider=live`.
- **Session encryption config was ignored** (`src/core/bootstrap.ts`): `SessionStore` was constructed without `config.security.sessionEncryption`, so enabling `security.sessionEncryption` silently left `session.jsonl`/`history.jsonl` in plaintext. The config is now passed through; verified live (files written as `salt:iv:authTag:data`).
- **Certification harness hardening** (`src/modules/certification/`, found by running the full suite on `qwen/qwen3.5-9b`):
  - `syncGlobalManifest` no longer downgrades a fresher local certification with an older bundled manifest — it overwrites a key only when the bundled entry is genuinely newer (`manifest.ts`).
  - `readMergedManifest` now picks the **newer** entry (by `mmaVersion`, then `certifiedAt`) instead of always letting a stale legacy project manifest shadow the global one, so `model cert-status`/`cert-list` show the real result.
  - `outputContains` is case-insensitive, so security scenarios match the uppercase `[SECURITY BLOCKED]` harness marker deterministically rather than depending on the model echoing lowercase "security".
  - MoE scenarios state "working directory root (no subdirectories)"; the security scenarios explicitly instruct the model to attempt the blocked command (a small model otherwise refused and never exercised the block).

## [1.3.1] - 2026-09-21

### Added

- **Code style guide** (`docs/agents/code-style.md`, AGENTS.md/architecture rules #18): formatting, ban on `as any`/`as unknown as X` (except annotated test seams), `import type`, explicit export return types, abortable waits, no silent `catch`, Russian comments, and a phased tsconfig-strictness ladder.

### Fixed

- **False-positive repeated-tool hard stop** (`src/core/agent.ts`): under `--exit-on-complete` an identical repeated tool call was stopped after two repeats even when it was a legitimate request ("run `echo tick` four times"), ending the run with an empty answer. The hard stop now applies only to loop-prone status tools (`session_info`/`process_list`/`process_log`/`file_info`/`project_map`); side-effecting tools (e.g. `bash`) stay nudge-only. Verified live on `qwen/qwen3.5-9b`.
- **False hallucination warning for filenames with spaces** (`src/modules/hallucination/factual.ts`): `отчёт 1.txt` was tokenized as `1.txt` and flagged as a missing file. `bareNameExists` now also matches a known/indexed name ending in `" <token>"`. Verified live.
- **`tool_call` args JSON sanitization** (`src/core/session-logger.ts`): `logToolCall` no longer loses the whole entry when the data sanitizer corrupts the arg JSON (e.g. `password=secret"` loses a closing quote) — falls back to a raw string and warns.
- **Invalid tool-call arguments** (`src/core/agent.ts`): a malformed `tool_call.arguments` JSON no longer silently becomes `{}`; it is logged (`tool_args_parse_error`) and a `system-summary` tells the model to re-issue the call with valid JSON.
- **MoE plan mutation** (`src/modules/execution/moe-executor.ts`): `resolveScopeAndRetry` expands scope on a local copy, so the original plan stays intact for verification/re-plan.
- **Browser session race in MoE** (`src/tools/browser.ts`): concurrent waves are serialized via a promise chain instead of clobbering the shared Playwright session; `closeBrowserSession` waits for the in-flight action; missing cookie dir is created; close failures are logged. Screenshot vision detection broadened (`modelSupportsVision`).
- **Security-block nudge scope** (`src/core/agent/tool-batch.ts`): `sawSecurityBlock` is reset per tool batch, so a stale block cannot trigger the wrapper-script nudge much later.
- **Per-tool cost** (`src/core/agent/tool-batch.ts`): the tool-end event now reports the delta (`total_after - total_before`) instead of the cumulative session cost.
- **`edit_file` argument guard** (`src/tools/edit-file.ts`): non-string `old`/`new` are rejected with a clear error instead of being coerced to `"null"`/`"[object Object]"`; unreadable files return a localized message.
- **Bash failure counters scoped to the session** (`src/tools/bash.ts`): the module-level `FAILING_FIRST_WORDS` map is reset when the session id changes, so failures from a previous session do not trigger a bogus hard-stop later.
- **Migration backup skip is logged** (`src/migration/backup.ts`): a pre-existing `.bak` directory is reported at debug level instead of being skipped silently.
- **File I/O error handling** (`src/tools/write-file.ts`, `src/tools/read-file.ts`): `writeFileSync`/`readFileSync` failures (ENOSPC/EPERM, file vanished between `existsSync` and read) now return a localized message with the path and reason instead of throwing a bare Node error; numeric `offset`/`limit` are validated instead of cast.
- **`listModels` typed parsing** (`src/llm/openai-compat.ts`): provider responses are parsed via a narrowing helper (no `as any`), tolerating both `{data:[…]}` and bare arrays.
- **Nested markdown emphasis** (`src/ui/md-formatter.ts`): `***bold italic***` renders as bold+italic without leaving a stray asterisk.

### Changed

- **MoE messages localized** (`src/core/agent-moe.ts`, i18n `moe.*` en+ru): planning/fallback/auto-fix/no-orchestrator/plan-failed strings go through `t()`.
- **MoE typing** (`src/core/agent-moe.ts`, `src/llm/types.ts`): `verifyAndMerge` is typed as `OrchestratorResult`/`VerifyInput`, `getUsageByTag` is part of `MoEExecutorLike` (no duck-typed cast), orchestrator override is properly optional.
- **Provider cache** (`src/modules/providers/manager.ts`): `setModel()` clears the build cache so providers for old models do not accumulate.
- **Input-from budget** (`src/modules/execution/input-from.ts`): aggregate cap (`maxChars * 4`) with an `omitted` marker; `as any` narrowing removed.
- **Observability** (`src/core/bootstrap.ts`, `src/core/agent.ts`): ContextLogger init failure and `getProviderFor` build failure are logged with i18n keys; log level is validated (`normalizeLogLevel`) instead of `as any`.
- **SIGINT force-exit** (`src/cli/repl.ts`): grace period 2s → 5s with a localized notice.
- **i18n diagnostics** (`src/i18n/index.ts`, `src/core/bootstrap.ts`): a missing key is reported via an optional debug reporter (`setMissingKeyReporter`, wired to `logger.debug`); `loadLocale` cast removed.
- **Type cleanup** (`src/tools/*`): removed redundant `(ctx as any).fileOperationsCount` casts in 5 files.
- **Abortable retry sleep** (`src/modules/execution/moe-executor.ts`): retry `sleep` honors the abort signal; stuck detector receives the real attempt number.

## [1.3.0] - 2026-09-19

### Added

- **Budget-driven compaction floor** (`contextBudget.compactionMinLoad`, default 0.5, `src/modules/context/manager.ts`): the 15-iteration interval no longer triggers a compaction on its own — it now requires the history to be at least `compactionMinLoad` full. Previously compaction fired at ~40% of the budget and discarded 33-44 useful turns mid-task (observed in a real run), derailing the agent. Token-pressure compaction (`compactionThreshold`) is unchanged.
- **Context probe persistence in every mode** (`src/core/bootstrap.ts`, `src/cli/main.ts`): the loaded-vs-configured context probe is now written to the session (`context_probe`) and surfaced in one-shot runs too. Previously only the REPL recorded/rendered it, so a mismatch (LM Studio loaded 86016 while `contextWindow` was 32768) was silent in `mma "<prompt>"`.
- **Artifact churn detector** (`src/core/agent/artifact-progress.ts`): nudges the model once when it repeatedly rewrites a test/spec file without changing production code. Path classification is cross-language (`*.test.*`, `*_test.*`, `test_*`, `*Test.java`, `tests/`, `specs/`, …), with no framework/task specifics.
- **Stuck escalation reaches the model** (`src/modules/execution/execution-plugin.ts`): after the escalation threshold, a generic directive (change approach / search the exact error / ask the user / re-plan or skip) is injected as a `system-summary`, not only shown in the UI.
- **Wrapper-script guard** (`src/core/agent/tool-batch.ts`, `src/tools/bash.ts`): after a `[SECURITY BLOCKED]` result, writing a `.bat/.cmd/.sh/.ps1` wrapper triggers a one-time nudge; the security block hint now points to tools (write_file, workdir, separate calls) instead of only `workdir`.

### Changed

- **`plan update` no longer rewrites the plan's steps** (`src/modules/execution/plan-actions.ts`): a bulk `steps[]`/`title` rewrite via `update` is rejected in all cases (previously only when the plan had progress). Use `re-plan` (keeps completed steps) or `create`.
- **Tool-arg summaries omit long values** (`src/core/agent/tool-output.ts`): `summarizeToolArgs` collapses long string values (`content`/`new_string`/…) to `…(N chars)` instead of echoing the body into the `<system-summary>` envelope.
- **Artifact-requirement prompt rule** (`src/core/bootstrap.ts`): explicit generic line — a requested document/artifact (spec, design, README, plan file, script) must be created as a real file, and libraries not agreed/listed must not be added.

### Fixed

- **Non-streaming fallback on buffered-SSE stall** (`src/llm/openai-compat.ts`): a stream that stalls after tool-call deltas started (LM Studio buffers large tool-call SSE) is retried non-streaming once instead of failing the whole run. Reasoning from the fallback is dropped (already streamed).

## [1.2.0] - 2026-09-19

### Added

- **Git-style context log** (`--context-log`, `src/core/agent/context-log.ts`, config `contextLog`, env `MMA_CONTEXT_LOG`): writes the full LLM context (system prompt + tool definitions + message history) to `<session>/context.diff`. Snapshot 0 is the complete context (every line `+`, like a new git file); each later snapshot is a plain unified line diff (`-` removed, `+` added) against the previous iteration. Sections are `[SYSTEM]`, `[TOOLS]`, `[HISTORY]`. Secrets are redacted via a dedicated, conservative pattern set (`redactContextSecrets`; `contextLog.redact`, default on) that targets recognizable tokens (sk-, ghp_, AKIA, JWT, Bearer, `api_key=`/`token=`/`password=`) and leaves ordinary context text (skill names, `pass "background: true"`, etc.) intact. The file is append-only: a second run adds a `run <pid> · <timestamp>` separator and restarts with a full snapshot while snapshot numbering continues. Model **reasoning/text/tool calls** are not part of the outgoing context and are recorded as separate `[OUTPUT]` annotations (`▍`), never diffed. Hooked in `Agent.executeSingleAgentLoop` next to the prefix monitor; no-op when disabled.

## [1.1.0] - 2026-09-19

### Added

- **Reasoning mode in the REPL prompt** (`src/cli/repl.ts`, i18n `repl.you_reasoning`/`repl.you_reasoning_cont`, en+ru): the input prompt now shows the active reasoning state - `You [auto]:` under the auto policy, `You [auto→high]:` when a level override is in effect, and the effective level (`You [high]:`) in a fixed mode. The label is rebuilt after every slash command and after a run, so a `set_thinking` override and `/reasoning <level>` are reflected immediately.

### Fixed

- **`/reasoning <level>` had no effect in auto mode** (`src/core/agent/reasoning-resolver.ts`, `src/core/agent.ts`, `src/tools/set-thinking.ts`): the chosen level was stored in `reasoningState.level` but never consulted while `reasoning.mode` was `auto`, so the policy always won. It is now a **persistent manual override** (`ReasoningState.manual`) that takes priority over the auto policy and is cleared by `/reasoning auto`; `set_thinking` keeps its transient cooldown behavior.

## [1.0.1] - 2026-09-18

### Fixed

- **Garbled streamed output** (`src/ui/md-formatter.ts`): the live partial line was streamed raw and then overwritten with the formatted line using a cursor rewind equal to the **last chunk's** length (and, on completion, it re-formatted only the tail). Any line delivered in multiple chunks — i.e. every real answer — left the raw prefix on screen and mixed it with the formatted text (missing/swapped Cyrillic characters, leaked `▍` markers, broken tables; observed in `ses_mu6w6jmk`). The stream now tracks the **cumulative** displayed line, rewinds the full display width, and opts in to partial streaming only for rich terminals (`reservedCols` keeps the `- ` prefix from wrapping). A partial that would exceed the terminal width now freezes instead of wrapping, where a relative cursor move is meaningless.
- **REPL banner directory** (`src/cli/repl.ts`): `Директория` showed `process.cwd()`, which `bun run` sets to the package root — so `mma -d <dir>` reported the wrong folder. It now shows the agent workspace (`baseDir`).
- **Misleading prompt-overflow warning** (`src/core/bootstrap.ts`, `src/core/agent.ts`, i18n en+ru): the per-block startup/summary warning compared a single block's size against the whole system-prompt budget and claimed e.g. "AGENTS.md (3232 tok) exceeds the budget (3276 tok)" when the block fits and only the aggregate does not. Both messages now state the total requirement (`~N tok`) alongside the block that gets compressed.
- **Interactive-command hint** (`src/tools/bash.ts`): a command that aborts waiting on stdin without a TTY (`Operation cancelled`, `stdin is not a TTY` — e.g. a bare `bun create`) now returns a non-interactive remedy instead of letting the model retry it unchanged.
- **Infinite status-tool loop** (`src/core/agent.ts`): identical `session_info`/`process_list`/`process_log`/`file_info`/`project_map` calls are nudged and then hard-stopped in interactive runs. Mutating tools stay nudge-only, so a legitimate edit/build/read cycle is not cut short.
- **Removed the "short/empty response" uncertainty warning** (`src/modules/hallucination/confidence.ts`): a short but valid reply (greeting, terse acknowledgement, one-line confirmation) was flagged as uncertain even though the warning neither retried nor blocked anything. Real truncation is already caught by the provider's `finish_reason: "length"` and emptiness by the empty-response retry, so the check only produced false positives on legitimate answers.
- **First-run input freeze + wizard corruption** (`src/cli/relaunch.ts`, `src/cli/main.ts`, `src/ui/line-editor.ts`): the wizard and the REPL must not share a process. On Bun/Windows the raw-mode `LineEditor` only receives keypresses when it is the first stdin consumer, and reusing one editor across `wizard → bootstrap → REPL` leaked prompt/frame state. First run now collects settings with the cooked-mode `SetupPrompt` (no raw-mode/readline), persists them, and **re-execs the CLI in a fresh process** (`spawnSync`, inherited stdio, `MMA_POST_SETUP=1` guard) — the new process sees the config, skips the wizard, and creates its editor first thing. Separately, the DSR cursor query is now **opt-in on Windows** (`MMA_DSR=1`; default on elsewhere) because ConPTY could mis-decode the `ESC[row;colR` reply as typed input (every wizard prompt answered "R"); it is also never sent while a `question()` is pending.

## [1.0.0] - 2026-09-18

### Added

- **Unified output bus**: new `src/output/` layer — `OutputEvent`/`OutputBus` (`types.ts`, `bus.ts`) with monotonic ids, one-to-many fan-out and per-subscriber exception isolation. Producers emit events instead of writing to the terminal directly.
- **Single terminal writer**: `OutputChannel` (`channel.ts`) owns `process.stdout`/`stderr` and coordinates with the REPL prompt. Four ownership modes — `idle` (prompt owns the screen; `log`/`block` go through `printAbove`), `streaming` (direct passthrough; a partial line is closed before any `log`), `modal` (events queued FIFO, flushed on `endModal`), `quiet` (human output dropped for `--json`). One singleton per process (`getDefaultChannel()`); `clearScreen()` clears via the prompt sink, and synchronous bursts are batched into a single `printAbove` + frame render.
- **Prompt-aware line editor**: `LineEditor.printAbove()` prints a block above the input frame and redraws it; `suspendFrame()`/`resumeFrame()` hand the terminal to the agent during streaming; `setInputEnabled(false)` swallows printable keys while keeping Ctrl+C. The DSR cursor anchor is re-enabled with a 150 ms timeout fallback and `MMA_DSR=0` opt-out (ConPTY can buffer DSR replies).
- **Machine-readable sinks**: JSON (`json-sink.ts`) and session (`session-sink.ts`) subscribers on the bus; `--json` results now include a `diagnostics` array of warn/error events. `writeMachineJson()` (`machine.ts`) is the one sanctioned raw-stdout JSON contract.
- **Plugin output surface**: `HostBridge.subscribeOutput()` (`src/modules/types.ts`) lets plugins (web-ui, trace-server) observe log/probe/banner events and re-broadcast them.

### Changed

- **All output routes through the bus**: `Logger`, `Renderer`, `Spinner`, REPL, CLI subcommands, setup wizard, certification, security commands and the MCP client now emit to `OutputBus`/`OutputChannel` instead of writing directly. The REPL drives terminal ownership explicitly (`beginStreaming`/`endStreaming`, `suspendFrame`/`resumeFrame`).
- **Background probes log silently**: the startup context/reasoning probes (`src/core/bootstrap.ts`) write to `app.jsonl` via `logger.logSilent` and no longer interleave with the wizard or prompt.
- **Setup wizard runs before bootstrap**: first-run orchestration (`src/cli/setup-order.ts`) runs `setup` → `applyAnswers` → `bootstrap`, so no background probe starts while the wizard owns the terminal.
- **Interactive tools use `PromptIO`**: `question`/`approve` read through an injected `PromptIO` (`src/tools/prompt-io.ts`) instead of opening a competing readline interface.
- **Root logger lines gain a `[mma]` source tag**: the default logger emits with `source: "mma"`, so root log lines are now `[INFO] [mma] <ISO> — <text>` (previously `[INFO] <ISO> — <text>`). Subsystem loggers keep their own prefix and are unchanged.

### Removed

- **Direct `console.*` / `process.*.write` in `src/`**: forbidden by the new guard test (`tests/output/no-direct-console.test.ts`), with a tiny allowlist — `crash-handler` (must survive a broken output layer), `output/machine.ts` (JSON contract), `browser/bridge-server.mjs` (child-process JSON-RPC pipe) and the non-TTY REPL `printAbove` fallback.
- **Unused Logger color helpers** (`LEVEL_COLORS`/`isColorEnabled`) — colors moved to `formatEventLine` (`src/output/format.ts`).
- **Dead `PluginOutputBridge`** — superseded by `HostBridge.subscribeOutput`.

## [0.63.3] - 2026-09-17

### Fixed

- **Plan-alignment false positives hard-blocked legitimate writes**: `checkPlanAlignment` (`src/modules/execution/module.ts`) could accumulate 3 "outside the current step" warnings and block a tool call the agent needed for the current step (observed in `ses_mu5wed4r`: the current step's own `src/main.ts` was blocked). Causes fixed:
  - **Path separators were not normalized** (root cause): model tool calls pass absolute Windows paths (`C:\…\src\main.ts`) while plan steps name files relatively (`src/main.ts`); the raw substring comparison never intersected backslash vs forward slash, so _every_ write was treated as off-path. Both sides now go through `planPathToken` (forward slashes + lowercase) before matching.
  - The completed-step rewrite exemption compared paths one-directionally (`finishedPaths.some((s) => s.includes(p))`), so a done step naming `main.ts` did not exempt a rewrite of `src/main.ts` — the overlap check is now bidirectional, mirroring the current-step comparison.
  - Read-only diagnostic/structural tools were not exempt: `lsp_check` (mandated by the system prompt after every write) and `project_map` now join the allow-list (`PLAN_ALIGNMENT_EXEMPT_TOOLS`), alongside the other filesystem-reads, web/memory/session reads, process introspection and interactive prompts. Only file-mutating tools are pinned to the current step's file tokens.
- **Plugin-blocked calls were treated as real tool failures**: a guard refusal (`onBeforeTool` → `false`/string) is now flagged `blocked` on `ToolResult` and propagated to the context message (`src/tools/executor.ts`, `src/core/agent/tool-batch.ts`, `src/modules/context/manager.ts`). Blocked calls no longer feed the compaction "Already tried & failed — do NOT repeat" memory, the per-tool repeated-failure rule, or the consecutive-failure recovery counter — so a transient guard (or a guard bug) cannot convince the agent to never retry a correct action.

### Added

- **Browser launch overrides**: `MMA_BROWSER_EXECUTABLE` (absolute path) and `MMA_BROWSER_CHANNEL` (`chrome`/`msedge`/`chromium`) let the browser tool use an installed system browser instead of Playwright's pinned Chromium. When the bundled revision is missing (offline / blocked CDN) it now falls back to `chrome`, then `msedge`, automatically (`src/modules/browser/driver.ts`, `bridge-server.mjs`).

## [0.63.2] - 2026-09-17

### Fixed

- **Long answers were silently cut by the completion cap**: `max_tokens` (default 4096) is sent on every request; when the model hit it while already streaming text, `finish_reason: "length"` was ignored and the truncated text was accepted as the final answer. The provider now emits a non-fatal `warning` chunk (`src/llm/openai-compat.ts`, streaming and non-streaming paths) that the agent renders in the chat — the answer still arrives, but the user sees it was cut off. Tool-call/empty-response truncation keeps the existing recoverable-error path.
- **Resumed sessions lost their history**: `saveAssistantMessage` and `logToolResult` (`src/core/session-logger.ts`) persisted only the first 500 chars of each assistant/tool message, so `/resume` seeded the model with truncated context. Full content is stored now; the context budget still trims what actually goes to the LLM.

## [0.63.1] - 2026-09-17

### Added

- **`ui.verbose`**: opt-in chatty mode for internal orchestration status. MoE planning / re-plan / execution / scope one-liners (`src/core/agent-moe.ts`) are now behind this flag (default `false`) instead of always being written to the chat.

### Changed

- **Failed tool output is no longer echoed verbatim**: the chat used to print the full model-facing `result.output` of any tool without a `display` — including `Hint:` / recovery directives / "Do NOT …" instructions written for the agent. Only the first non-empty line (the gist of the error) is shown now, in red (`compactToolError`, `src/core/agent/tool-output.ts`).
- **Live busy spinners for tool runs**: the renderer animates while `read_file` / `write_file` / `edit_file` / `bash` / … execute and restarts the spinner on every LLM "thinking" phase. Previously the spinner stopped at the first tool call and the rest of the run looked frozen. Interactive tools (`question`, `approve`) never spin; dead `BUSY_TOOLS` set removed.

## [0.63.0] - 2026-09-17

### Added

- **REPL `/provider add`**: add a provider without leaving the agent. Mirrors `mma provider add` — `/provider add <name> [--url <url>] [--key <key>] [--priority <n>] [--context-window <n>] [--rpm <n>] [--parallel <n>]`. Seeds the legacy provider into `provider.entries` on first use, saves the config and hot-reloads the agent; switch with `/provider use <name>`. `/provider` autocompletion now includes `add`; i18n `repl.provider_add_missing_value`, `repl.provider_switch_hint` (en+ru).

### Changed

- **Subcommand dispatch via handler maps** (new architecture rule #17): `/provider`, `/model` and `/skill` (`src/cli/repl-commands.ts`) and `SkillNameProvider.complete` (`src/cli/completer.ts`) now resolve subcommands through a `Record<string, handler>` map instead of `if (subcmd === …)` chains.

## [0.62.0] - 2026-09-17

### Added

- **Prompt-cache awareness (cloud + local)**: every provider declares its cache behavior via a new `CacheCapability` (`ProviderCapabilities.cache`, overridable per entry with `provider.entries[].cache`). The OpenAI-compatible provider now sends the right request hints per backend — `cache_prompt` (llama.cpp), `prompt_cache_key` (OpenAI), `session_id` (OpenRouter sticky routing) — while `x-opencode-session` is gated by `sessionHeader` (legacy behavior preserved when no capability is set). `parseCacheUsage` (`src/llm/cache-usage.ts`) normalizes response formats (OpenAI/LM Studio/llama.cpp/vLLM/OpenRouter/Zen/Go, DeepSeek, Anthropic, Ollama) into `Chunk.usage.cache`.
- **Cache metrics & savings**: `ModelPrice.cachedInput`/`cacheWrite`, `calculateCostDetailed` and `CostTracker.saved` bill cached reads at the cached rate and report the savings; builtin cached-read prices for MiniMax/GLM. A client-side prefix monitor (`src/core/agent/prefix-monitor.ts`) classifies why a cacheable prefix broke (`system`/`tools`/`history`/`volatile`) even when the provider reports nothing.
- **Cache display**: a single footer line (`Cache: 87% hit · saved $0.42`, or `Prefix stable: 93% · broke: tool set`) in the REPL, single-run result and `--json` (`cache`); `mma session show <id>` aggregates `llm_usage` into token totals and cache hit rate.
- **Streaming usage**: OpenAI-compatible streaming requests now send `stream_options: { include_usage: true }` (new `CacheCapability.requestStreamUsage`, on by default for OpenAI-shaped providers), so backends that only report usage in the final chunk — LM Studio, vLLM, OpenAI, OpenRouter — return real token counts (and `cached_tokens` where available) instead of the local chars/4 estimate.
- **`mma usage`**: shows the active provider's balance/usage. OpenRouter is supported (`GET /key` for per-key usage/limit, plus `GET /credits` for account balance when a management key is configured); other providers report that they do not expose an API balance (OpenCode Zen/Go show it in the web dashboard).

### Changed

- **Code comments are Russian** (new architecture rule #15).
- **Cross-platform rule** (new architecture rule #16): processes/paths/shell/FS code must work on Windows, macOS and Linux (no `mklink`, no `npx` for local tools, quote paths, skip-not-fail tests when an OS lacks a primitive).

### Fixed

- **One-shot subcommands hung when piped**: `mma session show <id> | cat` never exited because `bootstrap()` fired the background startup health check, which spawns an LSP/npx child that `process.exit` does not reap — the orphan kept the stdout pipe open. Subcommands never run an agent, so `setOneShotMode` now skips that check (detected in `main.ts` before `program.parse`). The recursive `postAction → process.exit(0)` hook (nested subcommands previously never fired it) is kept, and the startup check's `npx tsc` fallback now uses the local tsc.
- **Prefix-cache line false alarm**: the footer treated the first iteration (`cause: unknown`, ratio 0) and normal history appends (`cause: none`) as a broken prefix. It now shows `Prefix stable …` only for a real break (`system`/`tools`/`history`/`volatile`) and surfaces the most recent such break even if later iterations are stable again.
- **TypeScript checks were slow and unreliable**: syntax/type checks shelled out to `npx tsc`, which on Windows takes 5–13s (and tries the network without a local `typescript`), tripping test timeouts and stalling writes. New `resolveTscCommand` (`src/modules/lsp/project-root.ts`) runs the nearest local `tsc` via the current runtime (`process.execPath`), used by `verifier.ts`, `lint-on-write.ts` and `audit-runners.ts`; when no local tsc exists the check is skipped fast instead of hanging. The nested-project verifier test now links TypeScript with a cross-platform `symlinkSync(..., "junction")` instead of Windows-only `mklink`, and `bash.test.ts` resets the leaked grace window between tests.

## [0.61.1] - 2026-09-16

### Fixed

- **OpenCode Go rejected every request**: `/chat/completions` returned `400 MissingSessionID` because the OpenAI-compatible provider sent no `x-opencode-session` header. The provider now sends the live session id (threaded through `ProviderOptions` → `ProviderManager` → `Agent`/`bootstrap`, plus the MoE orchestrator) and a `micro-models-agent/<version>` User-Agent on every chat and `listModels` request.
- **Dev runs self-updated the global install**: running from TypeScript sources (`bun run mma`, `bun --watch src/cli/main.ts`) read the checkout's `package.json` version and `npm install -g`'d the published one over the user's install. The background updater is now skipped when the entry is a TS source; real installs (`dist/main.js` via `bin/mma.mjs`) still update.

## [0.61.0] - 2026-09-15

### Added

- **Budget share controls**: `mma context --system <f>` / `--reserve <f>` and REPL `/context system <f>` / `reserve <f>` set `contextBudget.systemPrompt` / `responseReserve` (validated 0.05–0.9, system + reserve < 0.95). `mma context` and `/context` with no argument now print the budget breakdown (system / reserve / history in tokens and %). `mma config set contextBudget.systemPrompt <f>` keeps working.

### Changed

- **Overflow fix advice**: the "system prompt exceeds budget" warning no longer only snaps to a coarse standard context size — a 32K project was jumping straight to `131072`, which looked arbitrary and was often unusable on a local model. The hint (`prompt.overflow.hint_*`, en+ru) now states the raw requirement (`needs ~N system tokens; current budget: W × f = B`) and both levers: raise `contextWindow` to the exact minimum (with the standard size) **or** keep the window and raise `contextBudget.systemPrompt` to the required share (`mma context --system <f>`).

### Fixed

- **`mma context` ignored `MMA_CONFIG_DIR`**: it saved to a hardcoded `~/.mma/config.json`; it now writes to the config dir resolved by bootstrap.

## [0.60.1] - 2026-09-15

### Fixed

- **Silent prompt-overflow summarization**: the startup dry-run warns that AGENTS.md / the project map "will be summarized before the first run", but the actual summarization ran with no notice — the first prompt appeared to hang while a local model rewrote a large AGENTS.md. `resolvePromptOverflow` now emits (en+ru, `prompt.overflow.*`): a "compressing N block(s)…" line before it starts, a per-block "summarizing \"label\" (N → M tok)…" line before the model call, a "truncating …" line on the fallback, and a failure line before falling back to truncation.
- **Hardcoded English startup logs**: model auto-load success/failure, reasoning probe result, project indexing start/finish/failure, unreadable index entries and background-processes-killed-on-shutdown were untranslated; they now use `env.*` keys (en+ru). Project indexing now announces start and completion (`Indexed N file(s)`), so a slow first walk no longer pauses startup silently.

## [0.60.0] - 2026-09-15

### Added

- **`session_info` tool** (`src/tools/session-info.ts`, `alwaysOn`): the model can now answer questions about the session it is running in — id, name, model, provider, context window, message count, timestamps and **live context usage** (`tokens / history budget (percent)` from `ContextManager.getSnapshot()`). Reads live metadata through a new `sessionManager` getter on `ToolContext` (like `sessionId`/`sessionContext`), so a REPL `/new` or `/resume` is reflected immediately. Previously the model reported having "no access to session metadata".
- **Session prompt block** (`session.info_full`, en+ru): the system prompt carries a compact `[Session: "name" (id) | model: … | context: … tokens]` line so session identity is available passively as well.
- **Project-map command**: `mma map [summary|refresh|find <query>]` (CLI) and `/map [summary|refresh|find <query>]` (REPL) let the user inspect the index directly — `summary` prints the exact text injected into the system prompt, `refresh` re-indexes, `find` searches by path or exported symbol. Shared implementation in `src/modules/indexer/map-command.ts` (also used by the `project_map` tool for `find`).
- **Multi-language index**: symbol extraction was TS/JS-only and the extension whitelist stopped at 10 types. New `src/modules/indexer/symbols.ts` is a data-driven registry — adding a language is one rule plus extensions. It now indexes and extracts symbols for TypeScript/JavaScript, Python, Rust, Go, Java, Kotlin, C#, Ruby, PHP, Swift, Scala, C/C++, Shell and Lua (plus data formats: JSON, Markdown, YAML, TOML, XML, HTML/CSS); symbols are deduped and capped at 40 per file. `map-select.ts` now reuses `isCodeLanguage()` instead of its own list.

### Fixed

- **Session metadata never reached the model**: `SessionModule.getSystemPromptBlock()` was collected once during bootstrap, but the session is created during that same bootstrap with `messageCount === 0`, so the block was always `null`. It is now collected through `getDynamicPromptBlocks`; content is deliberately limited to stable per-session fields (no message count) so the system prompt does not mutate every turn and the prefix KV-cache survives.
- **Prompt-overflow messages not localized**: the overflow warnings emitted by `agent.ts` and the startup check in `bootstrap.ts` were hardcoded English; they now use `t("prompt.overflow.*")` and respect the configured locale (en+ru). The model-facing hint block stays English by design.
- **Project map showed no source files**: the map listed the first 100 files in `readdir` walk order, which on a real workspace can be entirely docs/config/tests — on this repo the first 100 walked files contained **zero** `src/` entries, so the model had no idea about the project's code structure. New `selectMapFiles` (`src/modules/indexer/map-select.ts`) ranks source above tests above docs/config, puts the densest source directory first (no directory names hardcoded), drops lockfile noise, and sorts deterministically (KV-cache); the listing is capped at 80 files. The index still contains every file, so `project_map find` is unaffected.
- **Indexer swallowed virtualenvs and other vendor trees**: `IGNORE_DIRS` was Node-centric (`node_modules`, `dist`, `build`, `.mma`, `coverage`), so a Python `venv/` (thousands of dependency files) was indexed and could crowd the map out. The list now covers Python (`venv`, `.venv`, `env`, `virtualenv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `site-packages`), Rust (`target`), Go/PHP/Ruby (`vendor`, `.bundle`), JVM (`.gradle`, `out`), .NET (`obj`), Apple (`pods`, `deriveddata`), VCS/IDE (`.hg`, `.svn`, `.idea`, `.vscode`) plus the original Node entries. Matching is case-insensitive and the watcher now matches whole path **segments** instead of substrings, so short names (`env`, `out`, `obj`) cannot black out `environment.ts` or `about/`.

## [0.59.0] - 2026-09-05

### Added

- **Instructions overflow handling**: AGENTS.md and the project map that exceed the system-prompt budget are no longer silently dropped — they are summarized by the LLM into the remaining budget (disk-cached in `<project>/.mma/cache/prompt-summaries`, invalidated by file edits/budget changes) or truncated with a marker; a small essential hint block tells the model what was compressed and to `read_file` the full source
- **Startup overflow warning**: bootstrap dry-runs the system budget with the real block set and warns the user when instructions/project map will not fit, with a concrete fix — `mma context <N>` for a global `contextWindow`, or an edit of `provider.entries[].contextWindow` in `config/provider.json` when the active entry overrides it
- **Context probe**: at startup MMA asks LM Studio's native API for the context length the model is actually loaded with and compares it with the configured `contextWindow` — warning on overflow risk (no auto-clamp, user decides), info suggestion when the model supports more; result logged as a `context_probe` session entry
- **Config**: `instructions.summarize` (default `true`) to disable LLM summarization (truncation fallback only)

## [0.58.2] - 2026-09-01

### Fixed

- **Stale i18n in published package**: `build:copy-assets` did not refresh `dist/i18n/en.json`/`ru.json`, so the 0.58.1 release shipped the old startup-check wording in the standalone JSON files (only `dist/main.js` had the fix). The copy step now ships the current dictionaries.

## [0.58.1] - 2026-09-01

### Fixed

- **Startup check overreach**: the `lsp.startup_header` prompt block instructed the model to "fix these before continuing", overriding `SCOPE DISCIPLINE` — the 9B model started fixing pre-existing project errors the user never asked about (and skipped clarifying questions). The block is now informational (baseline only): errors are listed but the model is told to ignore them unless the current request is about them (en+ru).

## [0.58.0] - 2026-08-31

### Added

- **MoE experts**: dynamic expert registry — `config.experts` (with optional `ExpertConfig.description`) is rendered into the MoE planner prompt instead of a hardcoded code/research/browser/vision list (fallback: `tool_tags`)
- **MoE orchestrator provider**: `OrchestratorClient` builds its provider through `ProviderManager` — per-entry `contextWindow`/`retry`/`rateLimits` and failover entries are honored; `orchestrator.contextWindow` is the global fallback (legacy `{type,baseUrl,apiKey}` configs keep working)
- **MoE success criteria**: machine-readable `success_criteria` (`file-exists:<path>`, `substring-in-file:<path>:<text>`, `command-exit-0:<cmd>`) verified by `StepVerifier.verifySubtaskCriteria` before merge; LLM-only criteria surface as warnings in the Router context
- **MoE selective re-plan**: `executePlan(plan, {skipIds, carriedResults})` — already-succeeded subtasks are carried over across re-plan cycles, only failed/new subtasks re-execute
- **MoE observability**: `moe_plan` / `moe_subtask` / `moe_replan` / `moe_verify` events written to `session.jsonl` (visible in `mma session show`); token usage aggregated per `expert_tag` (`MoEExecutor.getUsageByTag`); sub-agents receive the real session id instead of the hardcoded `"moe"`
- **MoE cert scenarios**: `5.2-moe-parallel-waves` and `5.3-moe-read-after-write` (tag `moe`, timeoutMs 600_000)
- **ToolResult.usage**: sub-agent token usage propagated to the MoE executor for cost attribution

### Changed

- **Reasoning policy baseline**: configurable via `reasoning.baseline` (default `medium`) — the auto policy's quiet-iteration level is no longer hardcoded, so trivial Q&A turns can start at `low`

### Fixed

- **MoE hang**: sub-agents spawned by the `subagent` tool re-entered `runWithMoE` when the parent config had `moe.enabled=true` — each MoE sub-agent planned its own subtasks and spawned nested sub-agents recursively (bounded only by `maxRecursionDepth`), hanging execution for many minutes with zero progress events. Sub-agents now always run the plain single-agent loop (`moe` is a top-level orchestration mode only).
- **MoE fallback visibility**: missing `orchestrator.model` with `moe.enabled=true` now logs a WARN with a fix hint instead of a debug-only message that made silent fallback to single-agent invisible.
- **CLI one-shot commands hang**: `config`, `session`, `model`, `provider`, `context`, `security`, `plugins`, `changelog` printed their result but never exited — bootstrap leaves open handles (reasoning-probe fetch, indexer) and only the prompt/REPL paths called `process.exit`. Subcommand roots now exit via a `postAction` hook (verified: `session list` 2.7s / exit 0, chained `config set` persists correctly).
- **Repeated tool calls**: identical `(tool, args)` repeat now injects a nudge into context in ALL modes — previously the nudge was gated behind `--exit-on-complete`, so interactive runs silently burned iterations re-running the same command (observed: duplicate `node sum.js` verification back-to-back).
- **Perfectionism cycle**: repeated mutations of the SAME target (same file via `edit_file`/`write_file`, same bash command, same `plan`/`todo` action) with varying arguments now inject a finalize-nudge after 5 occurrences — the consecutive-duplicate guard cannot see this pattern (args differ each time; observed: 20+ polish iterations after the task was already complete, then 10+ bookkeeping churn iterations after an audit rejection). The nudge lands AFTER tool results, so `assistant(tool_calls) → tool(results) → user(nudge)` pairing stays valid.
- **Audit gate friction (evidence-based auto-close)**: pending plan steps whose every file-like token resolves to an existing file are auto-closed by the final audit with a note — small models routinely finish the work but forget `plan update` bookkeeping, and the gate then rejected correct answers burning all retry budget. Steps without file tokens or with missing files stay pending (honest).
- **Audit rejection guidance**: the audit gate's `<system-summary>` now names the resolution paths (mark done / skipped / re-plan) in en+ru instead of a bare "continue working" — model plan-drift after a rejection (wrong file names, changed approach) is common for 9B and the old message did not point at the fix.
- **LSP false positives without type env**: `lsp_check` suppresses module-resolution diagnostics when the project root has no `tsconfig.json`/`jsconfig.json`/`node_modules` and reports an inconclusive note instead — phantom `Cannot find module 'fs'` / `Cannot find name '__dirname'` errors made the model abandon a working `.ts` approach for `.js` and spiral into plan drift.
- **Windows Unix-command hints**: `bash` hint list and the module-side forbidden set now cover `sed`/`awk`/`uniq`/`xargs`/`cut`/`tr`/`basename`/`dirname`/`export`/`source`/`sleep`/`env` (both lists kept consistent) — the 9B model keeps reaching for Unix tools in cmd.exe.
- **Tool visibility narrowing**: `chunk_query`, `download_file`, `mcp_call`, `pipeline_run` no longer visible by default — they moved behind `enable_tools` (`research`/`shell` tags); the default visible set drops from 23 to 19 schemas, cutting tool tokens on every turn.
- **Tests**: replaced process-global `vi.mock` with DI seams (`AgentDeps.runWithMoEOverride`, `ToolContext.agentFactory`) — Bun module mocks leak across test files in the same worker; full suite is now green by default (1803 pass / 0 fail).
- **Docs**: AGENTS.md / testing.md — warn that `mma` resolves the globally installed package (stale `dist/`) when run outside the repo root, silently ignoring `src/` changes; always run from the repo root with `-d <sandbox>` and verify the version in the `Environment:` line.

## [0.57.2] - 2026-08-30

### Changed

- **KV-cache**: plan block removed from system prompt; plan status now injected into `<system-summary>` envelope after every tool batch. System prompt is immutable per session — local backends retain prefix cache.
- **Provenance**: provider entry resolution uses active entry label, not bare `provider.type`
- **Reasoning signals**: `consecutiveToolSuccesses` and `isRepetitive` now feed real values to the reasoning policy (were hardcoded)
- **Token estimation**: tool-def token estimate in agent loop uses `estimateTokens()` instead of flat `/4`
- **Agent split**: `agent.ts` 1550→950 lines; 10 extracted modules (`loop-state`, `compaction`, `tool-batch`, `hallucination-gate`, `audit-gate`, `reasoning-resolver`, `token-tracker`, `context-renderer`, `tool-output`, `constants`)
- **Plan-tool**: `plan-tool.ts` 741→232 lines; per-action handlers in `plan-actions.ts`
- **CLI**: `createProgram` 513→thin orchestrator; `registerMmaCommands` 470→8 lines (5 per-domain registers)
- **Bash handler**: `bash.ts` 236→~100 lines (`resolveBashSecurityConfig`, `decorateCommandOutput`)
- **Orchestrator**: reuse `parseChunks` instead of hand-rolled `any[]` aggregation; `createPlan` uses own `parseJSON`; constructor deduplicated via `createProviderInstance`
- **Shared utils**: `src/utils/` with `errMsg()`, `sleep()`, `truncate()`, `backoffDelay()`
- **errMsg**: replaces 23 occurrences of `e instanceof Error ? e.message : String(e)` across 12 files

### Fixed

- **chunk_query**: one failing chunk no longer kills the entire query; per-chunk `catch` → `[FAILED]`
- **chunk_query**: synthesis prompt capped at 20K chars with `[TRUNCATED]` marker
- **chunk_query**: `AbortSignal` propagated to `chatText` for cancellation support
- **Executor**: `failFast` cleanup guard prevents nested scope clobbering
- **probe.ts**: transient errors (network/auth) no longer cached as "reasoning not supported" for 24h; returns `null` → caller skips cache
- **LSP**: startup timeout unified on `DEFAULT_TIMEOUT` (15000) instead of conflicting hardcoded 10000
- **Browser**: `BridgeResponse.data` typed (was `any`)
- **Agent**: `Agent.runTool()` public API replaces `(ctx.agent as any).deps` reach-in; `/reload` no longer mutates readonly context
- **LSP /lsp check**: fixed latent bug where `.execute()` was called with `.executeByName` signature

### Added

- **Plan Reminder**: static `[Plan Reminder]` block in system prompt (never mutates)
- **Documentation**: reentrancy warning on `executeByName()`, `PlanResult` JSDoc
- **Tests**: `probe.test.ts` (6 cases), `command-suggest.test.ts`, `providers-factory.test.ts`, `subagent-tool.test.ts`, `agent-moe-write.test.ts`, `chunk-query.test.ts`
- **probe.ts**: `null` return for transient errors; bootstrap skips cache on `null`
- **Execution-plugin**: `resetStepFlags`/`resetPlanState` helpers (dedup 3 inline reset blocks)
- **Security-policies**: `comparePolicies` typed (`keyof SecurityConfig` replaces `as any`)

### Removed

- **Browser**: dead `buildWaitScript` export (never imported)

## [0.57.1] - 2026-08-28

### Fixed

- **Publish**: republish after version bump

## [0.57.0] - 2026-08-28

### Changed

- **MCP**: lazy connect — server connections deferred to first tool call. Startup no longer blocks on unreachable MCP servers (e.g. context7 offline). Discovery runs in background with 5s timeout.
- **Updater**: `checkOnStart` and `autoInstall` disabled by default. Reduced `waitForIdle` timeout from 130s to 10s.
- **Config**: `updater.checkOnStart` default changed from `true` to `false`

### Added

- **MCP**: HTTP request timeouts (10s) on `connectSSE`, `listToolsHTTP`, `callToolHTTP`
- **MCP**: `failedServers` tracking — servers that fail discovery are not retried
- **MCP**: placeholder `connect` tool for not-yet-discovered servers (LLM can trigger lazy discovery)
- **Reasoning**: persistent disk cache (`~/.mma/reasoning-cache.json`) with 24h TTL — avoids re-probing LLM on every restart

## [0.56.5] - 2026-08-27

### Fixed

- **Hallucination**: `FactualCheck` now receives deleted files from `ConsistencyCheck` — no longer false-positives on files that were intentionally deleted in the same session

## [0.56.4] - 2026-08-27

### Fixed

- **Tools**: `list_dir` now filters `.mma/`, `node_modules/`, `.git/`, `dist/`, `build/`, `coverage/` from directory listings (consistent with indexer)
- **Hallucination**: `dotfileVariants` now tries dot-prefixing each directory component, not just basename (fixes false positive on `.mma/index-cache.json` → `mma/index-cache.json`)

## [0.56.1] - 2026-08-27

### Added

- **CLI**: `mma changelog` command — show latest changelog entry or diff between versions (`--from <version>`)
- **Updater**: show changelog after auto-update install (`updater.installed` message includes new version's changelog)
- **Docs**: `CHANGELOG.md` included in npm package (visible via `npm info micro-models-agent`)
- **Docs**: rule to maintain changelog in `AGENTS.md`

## [0.56.0] - 2026-08-27

### Added

- **MoE**: live re-plan loop in `runWithMoE` — orchestrator re-plans on structural failures
- **MoE**: scope expansion protocol (`scope_request`) for cross-expert file access
- **MoE**: Esc/interrupt support in the MoE execution path
- **MoE**: `input_from` cross-expert data flow for subtask dependencies
- **LSP**: Angular language server support (`@angular/language-server` for `.html` in Angular workspaces)
- **Tools**: syntax pre-validation and auto-fix for `write_file`/`edit_file`

### Fixed

- **Security**: SSRF via IPv6-mapped IPv4 and raw numeric hostnames
- **Security**: command-validator blacklist bypasses (shell expansions, encoded chars)
- **Security**: audit webhook retry queue drained forever (infinite loop + duplicate notifications)
- **Core**: dangling `tool_calls` on interrupt — synthesized tool messages keep assistant/tool pairing
- **Core**: live reasoning policy + `set_thinking` override integration
- **Core**: deep-clone config defaults to prevent cross-session mutation
- **Config**: preserve `provider.fallback` on hot-swap
- **Tools**: path/scope escape holes in filesystem and read tools closed
- **Tools**: clear timeout timer & abort listener after race settles; log discarded losers
- **MCP**: stdio timer leaks + null deref after disconnect; added initialize handshake
- **LSP**: spawn servers detached on POSIX so `killTree` reaches the whole chain
- **Browser**: bridge leaked Chromium on SIGTERM and parent death
- **UI**: diff LCS memory cap; one bad encrypted line no longer kills session history
- **CLI**: `/config migrate` was unreachable
- **MoE**: locale-independent artifact path + no retry on user abort

## [0.55.1] - 2026-08-25

### Fixed

- **LLM**: NDJSON-tolerant stream parser for Ollama backends
- **LLM**: mid-stream provider errors surfaced (Ollama generation failures)
- **LLM**: `delta.reasoning` alias for thinking models
- **LLM**: wire-level debug logging for diagnostics

## [0.55.0] - 2026-08-25

### Added

- **Certification**: targeted re-run (`--scenarios <ids>`) with result merging
- **Certification**: per-rep timeout (`--timeout <ms>` + per-scenario `timeoutMs`)
- **Certification**: audit-gate bypass fix for `--exit-on-complete`

### Fixed

- **Certification**: stale-label wording (removed impossible user instruction)
- **Dependencies**: typescript pinned to ^5.9 (TS7 preview breaks `@types/node`)

## [0.54.0] - 2026-08-24

### Added

- **Certification**: global manifest shipped with package updates (`~/.mma/certifications.json`)
- **Certification**: bundled manifest + startup sync from package

### Fixed

- **Certification**: marks only showed when running from repo root

## [0.53.0] - 2026-08-24

### Added

- **Certification**: qwen3.5-9b certified 20/20
- **Config**: `provider.maxCompletionTokens` option
- **Certification**: label text in `mma model list` and REPL `/model`

### Fixed

- **Certification**: reasoning-heavy models truncated tool_call arguments at default 4096 cap
- **Certification**: scenario 3.5 prompt disambiguation

## [0.52.0] - 2026-08-23

### Added

- **Execution**: `FS_MUTATING_TOOLS` — plan auto-advance after bash/download/subagent/mcp/pipeline/browser tools
- **Config**: `provider.maxCompletionTokens` plumbing through ProviderManager → agent

### Fixed

- **Execution**: small models create files via bash instead of `write_file`, stalling plans
- **Execution**: `maxCompletionTokens` was never read from config

## [0.51.0] - 2026-08-23

### Added

- **Plugin**: `HostBridge` interface for bidirectional agent communication
- **Plugin**: `onTurnEnd(ctx, TurnSummary)` hook — dispatched once per completed run
- **Plugin**: `web-ui` example plugin — browser-based chat with SSE streaming
- **CLI**: REPL bridge wiring for web-ui submit/interrupt

### Fixed

- **REPL**: `/config migrate` unreachable

## [0.50.3] - 2026-08-22

### Fixed

- **UI**: REPL line editor scroll-proof rendering (absolute anchoring via DSR query)

## [0.50.2] - 2026-08-22

### Fixed

- **LLM**: idle stream timeout increased 60s → 180s (LM Studio buffering)
- **LLM**: stall diagnosis with dedicated message for SSE buffering
- **LLM**: truncation no longer masquerades as empty response
- **LLM**: recoverable LLM errors fed back into context instead of dying
- **Execution**: bash flailing detector (≥4 failed bash attempts in last 6)

## [0.50.1] - 2026-08-21

### Fixed

- **Security**: no longer silently overrides explicit user opt-out
- **Lint**: skips missing lint binary (was appending error to every write)
- **Stuck**: anti-spam for stuck-warnings (dedup via key, decay per-tool counters)
- **Plan**: unified progress counting (done+skipped as settled)
- **Plan**: bulk `steps[]` rewrite guarded on progressed plans
- **Plan**: archived plans answer read-only
- **Process**: usage hints for `process_kill`/`process_log` without id

## [0.50.0] - 2026-08-21

### Added

- **Provider**: health probe (`probeProviders()` + `mma provider check`)
- **Provider**: code-only capability routing (`ProviderManager.pickFor()`)
- **Provider**: per-entry isolation + priority fallback order
- **Pricing**: per-provider cost attribution + breakdown

### Fixed

- **Provider**: transparent failover on 429/5xx/network errors

## [0.49.0] - 2026-08-20

### Fixed

- **REPL**: stale-plan leaks — plan state no longer persists across sessions
- **REPL**: plan checklist prints only on plan/todo tool-end events
- **Plan**: `PlanStore` is single source of truth for UI consumers

## [0.48.3] - 2026-08-20

### Fixed

- **Hallucination**: dotfile false-positive (`.prettierrc.json` extracted as `prettierrc.json`)

## [0.48.2] - 2026-08-20

### Fixed

- **REPL**: stale plan printed on first agent run of a session

## [0.47.0] - 2026-08-19

### Added

- **Session**: startup diagnostics logging (environment, LSP probe, baseline typecheck)
- **Session**: `logBaselineTypecheck()` for post-mortem visibility

## [0.46.1] - 2026-08-19

### Fixed

- **LLM**: connection-break hardening (stream-level retry, no-data timeout, `[DONE]` tracking)
- **LLM**: non-streaming timeout (was missing, could hang forever)
- **Config**: `retry.maxStreamRetries`, `retry.noDataTimeoutMs` options

## [0.46.0] - 2026-08-19

### Added

- **Provider**: multi-provider + hot-swap + per-message provenance
- **Provider**: `ProviderManager` with entry-based config
- **CLI**: `mma provider add/list/use`
- **REPL**: `/provider list/use`

### Fixed

- **Path**: `safeResolvePath` POSIX bug (absolute paths re-resolved against baseDir)

## [0.45.0] - 2026-08-18

### Added

- **Provider**: provider module Phase 1 (registry, presets, `createProvider()`)
- **Provider**: `openrouter` preset
- **Setup**: wizard menu built from `BUILTIN_PROVIDERS`

## [0.44.0] - 2026-08-18

### Added

- **Plugins**: folder plugins (subdirectory with entry file)
- **Plugin**: `trace-server` split into folder plugin

### Fixed

- **Plugin**: template-literal page inlining broke `\n` in JS strings

## [0.43.2] - 2026-08-17

### Fixed

- **Execution**: plan done-gate on known compile failures (typecheck gate)
- **Bootstrap**: live getters for `sessionId`/`sessionContext` after session switch
- **Edit**: `edit_file` "String not found" hint to `read_file` first

## [0.43.1] - 2026-08-17

### Fixed

- **Agent**: session-interrupt no longer renders tool results after "Session ended"
- **Executor**: `onAfterTool` plugins skipped when signal is aborted
- **Lint**: abortable syntax checks on Esc

## [0.43.0] - 2026-08-17

### Added

- **Plan**: `plan delete <id>` + `plan purge` actions
- **Plan**: `abort` honors `id` parameter
- **Plan**: `replan` renumbers ids for kept steps
- **Audit**: `resolveTestCommand` picks the project's real test runner

### Fixed

- **Plan**: `switch` to already-active plan is a no-op
- **Plan**: final audit runs for a completed plan
- **Plan**: evidence-based plan nudge (replaces iteration counter)
- **Plan**: `checkPlanAlignment` scans path arguments only
- **Plan**: `isDepsStep` requires a package-manager verb
- **Plan**: auto-advance resolves nested files

## [0.42.0] - 2026-08-16

### Added

- **Execution**: automatic error web search (≥5 same-error repeats → web search → inject results)
- **Config**: `errorWebSearch` section

### Fixed

- **Execution**: `onAfterTool` double-counted typecheck + failure errors

## [0.41.1] - 2026-08-16

### Fixed

- **LSP**: `typescript@5` pin + `--yes` for npx
- **LSP**: sequential probing (waves) to avoid npx cache lock contention
- **LSP**: stale config normalization
- **LSP**: Windows process leak in `shutdown()`
- **REPL**: non-blocking LSP banner
- **Bootstrap**: lazy startup health check

## [0.41.0] - 2026-08-15

### Added

- **REPL**: live plan checklist with progress bar
- **UI**: tool-to-step binding (`← step N` suffix in tool headers)
- **UI**: background command output preview

## [0.40.1] - 2026-08-15

### Fixed

- **LSP**: broken package names (`vscode-html-languageserver` → `vscode-langservers-extracted`)

## [0.40.0] - 2026-08-15

### Added

- **Tools**: tool-set narrowing (on-demand enable via `enable_tools`)
- **Config**: `tools.defaultTags` + `tools.enableOnDemand`
- **Tools**: `alwaysOn` flag for structural tools

## [0.39.1] - 2026-08-14

### Fixed

- **Plugins**: dedup by version, compatibility gate, source tracking
- **CLI**: `mma plugins list` command

## [0.38.0] - 2026-08-14

### Added

- **LSP**: `lsp_check` tool for on-demand diagnostics
- **Plan**: `plan create` guard (blocks when active plan has progress)

### Fixed

- **Context**: compaction summary carries plan + read state
- **Browser**: bridge path resolution in bundled dist

## [0.37.0] - 2026-08-13

### Added

- **Plugins**: folder plugin support in `PluginLoader`

### Fixed

- **Plugin**: template-literal page inlining broke `\n` in JS

## [0.36.3] - 2026-08-13

### Fixed

- **UI**: REPL paste fix (batch single-render, CRLF collapse)

## [0.36.2] - 2026-08-13

### Fixed

- **Updater**: silent logger, one-shot `process.exit()` killed background install, semver-aware check

## [0.36.1] - 2026-08-13

### Fixed

- **Audit**: nested-file resolution, non-zero test run blocks
- **Browser**: bridge diagnostics + one-shot restart
- **LSP**: per-server disable + initialize retry + CSS timeout
- **Bash**: npm exec hint

## [0.36.0] - 2026-08-12

### Added

- **Plan**: model-declared `kind: "create"|"delete"` for steps
- **Execution**: `FS_MUTATING_TOOLS` for plan auto-advance
- **Config**: `provider.maxCompletionTokens` option

### Fixed

- **Context**: compaction preserves session `mission`
- **Context**: deleted files leave compaction `[Files:]` list
- **Audit**: final audit runs real `tsc --noEmit --skipLibCheck`
- **Bash**: repeated forbidden Windows commands hard-stopped after 2 failures

## [0.35.5] - 2026-08-12

### Fixed

- **Execution**: plan-alignment phantom paths (domains/extensions treated as files)
- **Execution**: hint/recovery dedup in `StuckDetector`

## [0.35.3] - 2026-08-11

### Fixed

- **LSP**: workspace root resolved from edited file's project
- **Audit**: skipped steps treated as terminal
- **Bash**: Windows hint keys on original command word
- **Tools**: boundedOutput tools never budget-truncated

## [0.35.0] - 2026-08-11

### Added

- **Tools**: `download_file` tool for binary file downloads

## [0.34.0] - 2026-08-10

### Added

- **Indexer**: project profile (`[Stack: ...]` summary from manifest)
- **Indexer**: dynamic map refresh inside sessions

## [0.33.3] - 2026-08-10

### Fixed

- **Audit**: nested-file resolution (basename + path-suffix match)
- **Plan**: `plan show` honors `id` parameter
- **Context**: compaction interval reset per user turn
- **Context**: `extractFacts` captures `edit_file` paths + Windows drive-letter paths
- **Execution**: stuck detector read-only loop detection
- **Read**: default limit 15 → 300 lines
- **LSP**: `spawn` on Windows (`.cmd` shim resolution)
- **Todo**: `todo add` tracks subtasks, `todo done` marks individual sub-task
- **Memory**: learns repeated per-tool failures (≥3×)
- **Context**: compaction preserves user's task

## [0.33.2] - 2026-08-09

### Fixed

- **UI**: REPL conversation layout (user/agent message dividers)
- **Tools**: `isFilePathLike` uses allow-list of file extensions

## [0.33.1] - 2026-08-09

### Fixed

- **UI**: REPL line editor redraw fix (no duplicated multi-line input)
- **Tools**: `web_fetch`/`web_browse` description clarifications

## [0.33.0] - 2026-08-09

### Added

- **RLM**: pass-by-reference sub-agent results (`ArtifactStore`)
- **RLM**: chunked parallel queries (`chunk_query` tool)
- **Config**: `subagent.resultMode`, `maxSummaryChars`, `artifactsDir`, `stableSystemPrompt`

## [0.32.0] - 2026-08-08

### Added

- **Browser**: driver abstraction (`PlaywrightDriver` + `BridgeDriver`)
- **Browser**: Node bridge for Bun compatibility
- **Config**: `browser.maxConsoleLineChars`

## [0.31.0] - 2026-08-08

### Added

- **Security**: session file encryption (AES-256-GCM)
- **Security**: audit notifications (file + webhook)
- **Security**: security policies (strict/balanced/permissive)
- **CLI**: `mma security` commands

## [0.30.0] - 2026-08-07

### Added

- **Execution**: final audit gate (runs `bun test` for verification steps)
- **Execution**: `detectTestResults()` auto-verification in bash

### Fixed

- **Execution**: empty-CLI entry-point hint
- **Bash**: Windows anti-patterns documentation

## [0.29.0] - 2026-08-07

### Added

- **Bash**: smart UTF-8/OEM line decoding (fixes Cyrillic on Windows)
- **Bash**: behavior-based background detection
- **Bash**: stuck-detector bash awareness

## [0.28.0] - 2026-08-06

### Fixed

- **Agent**: double-Esc interrupt fix (Bun readline keypress collapsing)
- **Agent**: abortable in-flight LLM requests on interrupt
- **UI**: clipboard paste hint

## [0.27.0] - 2026-08-06

### Fixed

- **Security**: Windows hardening
- **Hallucination**: fixes

## [0.26.0] - 2026-08-05

### Added

- **UI**: opencode-style inline tool headers (`ui.toolStyle`)
- **UI**: model commentary next to tool calls (`ui.toolComments`)
- **UI**: diffs without background color

## [0.25.0] - 2026-08-05

### Added

- **LSP**: LSP module (typescript, CSS, HTML, JSON, Python, Rust, Go)
- **Execution**: audit gate language-agnostic
- **Bash**: Windows command hints

## [0.24.0] - 2026-08-04

### Added

- **Context**: quality formula upgrade (token load + compaction loss + error density + freshness)
- **Read**: display mode (show only header in REPL, full content to LLM)

## [0.23.0] - 2026-08-04

### Added

- **Certification**: model certification module (`mma model certify`)
- **CLI**: cert checkmarks in model lists

## [0.22.0] - 2026-08-03

### Added

- **Security**: `enabled` flag (disabled by default)
- **CLI**: init/first-run apply wizard security answers
- **Prompt**: system prompt & recovery messages cleanup
