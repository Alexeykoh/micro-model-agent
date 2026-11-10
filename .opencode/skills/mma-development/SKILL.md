---
name: MMA Development
description: Playbook for developing the MMA (micro-models-agent) repo — branches, gates, definitions of done, recipes for tools/config/commands/skills, traps. Use for any code, test or docs change in this repository.
---

# MMA — development playbook

`AGENTS.md` is the normative rulebook (always loaded); this skill is the **practical
playbook** — the order of operations and copy-paste recipes. When they conflict,
AGENTS.md wins; report the conflict.

## Start a task

1. Branch from `dev`: `<type>/<short-name>` (`feat/|fix/|docs/|refactor/|chore/`).
   Never work in `dev` directly; never commit to `master` (release branch).
2. If the change touches a **contract** (data path, module boundary, enforcement
   point, event format, config schema) — write the spec first in
   `docs/specs/<YYYY-MM-DD>-<topic>-design.md`, commit it in the same branch.
3. If it touches `src/core/`, `src/tools/executor.ts`, `src/modules/security/`,
   `src/config/` — read §1 of `docs/specs/2026-10-12-architecture-v2-design.md` first.
4. Split: a task that edits core + module + web + config is **four waves**, each with
   its own verifiable result.

## Definition of done (all of it)

```bash
bun test           # ~3800 tests, must be green
bun run quality    # typecheck + typecheck:frontend + lint + fallow + check:arch
```

- Behavior change → a test that **would fail** without your change.
- UI/CLI change → a live run (`bun run mma "<prompt>"`), evidence in `session.jsonl`/log.
- Check all three dimensions: user UX · model ergonomics · adjacent modules.
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
artifacts. No npm publish, no gitea mirror.
