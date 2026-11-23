---
name: MMA Development
description: Playbook for developing the MMA (micro-models-agent) repo — branches, gates, definitions of done, recipes for tools/config/commands/skills, traps. Use for any code, test or docs change in this repository.
---

# MMA — development playbook

`AGENTS.md` is the normative rulebook (always loaded); this skill is the **practical
playbook** — the order of operations and copy-paste recipes. When they conflict,
AGENTS.md wins; report the conflict.

## Start a task

1. Default branch point is `dev`; name the branch `<type>/<short-name>`
   (`feat/|fix/|docs/|refactor/|chore/`). Never work in `dev` directly; never
   commit to `master` (release branch). Exception: when the user explicitly asks
   for a branch from the current line (e.g. live work on `integration/vX.Y.Z-*`),
   follow that instruction — the user's branch point wins over the default.
2. If the change touches a **contract** (data path, module boundary, enforcement
   point, event format, config schema) — write the spec first in
   `docs/specs/<YYYY-MM-DD>-<topic>-design.md`, commit it in the same branch.
3. If it touches `src/core/`, `src/tools/executor.ts`, `src/modules/security/`,
   `src/config/` — read §1 of `docs/specs/2026-10-12-architecture-v2-design.md` first.
4. Split: a task that edits core + module + web + config is **four waves**, each with
   its own verifiable result.

## Definition of done (all of it)

```bash
bun test                                    # full suite, must be green
bun test tests/core/agent.test.ts           # one file
bun test tests/core/agent.test.ts -t "name" # one test
bun run quality                             # typecheck + frontend + check:arch + lint + fallow
```

- Behavior change → a test that **would fail** without your change.
- UI/CLI change → a live run (`bun run mma "<prompt>"`), evidence in `session.jsonl`/log.
- Text visible to the model/user → evidence in `session.jsonl` or a log entry.
- Docs-only → `bun test tests/docs-link-check.test.ts` (links must resolve).
- Check all three dimensions: user UX · model ergonomics · adjacent modules.
- CI is stricter: coverage 87% funcs / 90% lines, `bun run evals:check`,
  `bun test tests/replay`, POSIX `bun run quality:posix`. Local green ≠ CI green.
- Integration: merge to `dev` only when both commands are green.

## Recipes

**New tool** — `src/tools/<name>.ts`, add to `registerAllTools` array in
`src/tools/index.ts`. `ToolDefinition` must declare
`security: { caps, pathArgs?, urlArgs?, manual? }` (compile error without it);
enforcement happens in `ToolExecutor.execute()`, **never** in the handler. Set
`tags`, `alwaysOn`, `timeoutMs`, `boundedOutput` deliberately.

**New config key** — default only in `src/config/registry-extra.ts` groups
(`registry.ts` is grandfathered). Types: string/int/share/bool/enum/json/list.
`set` returns effects (`context.resize`, `provider.rebuild`…), not booleans.

**New slash command** — declare in `src/core/commands/spec.ts` (catalog), bind the
handler in `src/cli/repl-commands*.ts` via the handler map. Never a chain of `if`.
Add i18n keys to **both** `en.json` and `ru.json` (`tests/i18n.test.ts` enforces parity).

**New built-in skill** — `src/modules/skills/builtin/<file>.md`, frontmatter
`name` (required), `description`, `keywords`, `mma_version: 2`. Copied to
`dist/skills/builtin/` by `scripts/copy-assets.ts` at build — it only loads from the
bundled `dist/main.js`; while developing, test via `.mma/skills/` (gitignored, scanned
per run).

**New module** — `src/modules/<name>/`, wire in a bootstrap phase under
`src/core/bootstrap/`; decide `critical?`/`teardown?` (§3.3 of the v2 spec). Module
imports core only via `src/core/api/` — `tests/arch/module-boundaries.test.ts`.

**New architectural rule** — ship the guard with it (`tests/arch/*`, `tests/output/*`);
a rule without a check dies by the next big change (AGENTS.md rule 5).

**System prompt edit** — text lives in `src/core/system-prompt-render.ts`
(`system-prompt.ts` is a barrel). Keep compact-core ≤910 tokens
(`tests/core/system-prompt-compact.test.ts`) and ≤120 chars per runtime line;
update the golden snapshot deliberately with `bun test -u tests/core/system-prompt-compact.test.ts`.
Guard phrase-locked strings in `tests/core/bootstrap.test.ts`. Compound lines with
`+` are fine for source length but not for the runtime line guard.

**session.jsonl format change** — even an additive optional field counts as a
contract change: write the spec first, then update both `src/modules/session/log-types.ts`
and `src/core/session-log-telemetry.ts` plus the emitting site.

## Hard constraints (guards will fail you)

- Every `src/**/*.ts` ≤ 300 lines; `.arch-allowlist.json` is empty and only shrinks.
- No direct `console.*`/`process.*.write` in `src/` — emit `OutputEvent` on `OutputBus`.
- No `as any`. No boxed panels in chat output; tool names never shown to the user
  (only `tool.friendly.*`); one action glyph `◇` — canon in `docs/design/ui/STYLE.md`.
- i18n: every user-visible string through `t()`.
- Versions are `0.x.y` only (beta); `1.0.0` fails `tests/version-beta.test.ts`.
- Protected paths (`.git/`, `.env*`, keys, `.npmrc`, `.netrc`) are always-on.

## Testing conventions

- vitest via `bun test`; **never `vi.mock`** in agent tests (Bun makes it global to
  the process) — use seams: `ToolContext.agentFactory`, `criticOverride`, `finalAudit`.
- Anything that writes config → set `MMA_CONFIG_DIR` to a temp dir; never touch real
  `~/.mma`.
- Long commands (dev server, `mma web`, watchers) start with `background: true`;
  readiness-poll with a small cap; kill by exact PID after the check.
- Playwright (`bun run test:e2e`) only on explicit user request.

## Traps

- Running `mma` outside the repo hits the **global install**; run from repo root and
  verify the version in the `Environment: … mma <version>` banner against `package.json`.
- `bunfig.toml` excludes `tests/integration/**` from `bun test`; a test placed there
  silently never runs. Put it in `tests/` or run `bun run test:integration`.
- A guard may read a re-export shim, not the file you edited: e.g.
  `tests/core/system-prompt-line-length.test.ts` reads `src/core/system-prompt.ts`
  while prompt strings live in `src/core/system-prompt-render.ts`. Check what the
  guard actually reads before trusting it.
- `CHANGELOG.md`: not one line without an explicit user command — not for a fix,
  test, spec or refactor (AGENTS.md rule 10). Use `bun run changelog:add` only on request.
- Disabling a plugin ≠ sandbox: module code already ran; `permissions` is display-only.
- `gh-pages/` is intentionally excluded from gates.
- Three i18n keys exist only in `ru.json` (`cli.config_value`, `cli.show_secrets`,
  `cli.context_size_arg`) — never add new ones.
- Debt must be registered in `docs/agents/debt.md` with id/reason/exit-criterion/
  trigger, and marked `DEBT(<id>)` at the code site — pay-once, no silent re-deferral.

## Release

Only on explicit user decision: update `CHANGELOG.md` + `package.json` (PATCH for
fixes/i18n/docs/tests, MINOR for new commands/tools/modules/keys/skills) → merge
`dev` → `master` (plain merge) → tag `vX.Y.Z` on master; CI builds 5-platform
artifacts. No npm publish, no gitea mirror. Versions are `0.x.y` only (beta).

Channels are not mixed: stable tag `vX.Y.Z` only from `master`/`vX_Y_Z`;
pre-tag `vX.Y.Z-pre.N` only from the rolling `pre` branch (recreated from the
release branch each cycle); `package.json` always holds a clean `X.Y.Z`.
`tests/arch/release-branches.test.ts` guards the branch↔tag invariant.
