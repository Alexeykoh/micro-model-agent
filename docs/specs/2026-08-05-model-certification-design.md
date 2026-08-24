# Model Certification Design

**Date:** 2026-08-05
**Status:** Approved
**Author:** opencode

## Problem

MMA runs on small models (e.g., Qwen3.5-9B) that are known to fail in non-obvious ways: llama.cpp Jinja-templating violations, streaming `tool_calls` that return empty, models that "forget" tools on the second iteration. There is no way for a user to know whether a given model will actually work with MMA — the list of available models (`mma model list`, REPL `/model`) shows names with no quality signal.

There is a manual test-suite document (`docs/testing/scenarios.md`) covering features, simple tasks, multi-step planning, security, and image support — but it is executed by hand and has already drifted (scenarios 1.1/1.2 test `question`/`approve` tools that were removed from `tools/index.ts`).

## Goal

Provide an offline **certification harness** that runs test scenarios through the real agent against a concrete **(model, provider)** pair, records machine-verifiable results in a manifest, and surfaces a checkmark in model lists so users can distinguish "verified on this backend" from "untested".

A certification is **not** a general endorsement of a model. It is an honest statement: *"on this exact provider URL, this model ran the suite and passed N/M repetitions."*

## Non-Goals

- No real-time/online evaluation — the harness is an offline, on-demand command.
- No LLM-judged scenario verification — only machine fact-checks.
- No interaction with the agent loop itself — certification is an external tool, not an `AgentModule`.
- No marketplace or publishing of certificates.

## Architecture

New standalone module `src/modules/certification/`. It does **not** participate in agent runs and does not add anything to the system prompt or context budget.

```
src/modules/certification/
├── types.ts        # Scenario, CertCheck, CheckResult, ScenarioResult, CertificationEntry
├── scenarios.ts    # Built-in scenarios (ported from docs/testing/scenarios.md, tagged)
├── loader.ts       # Scenario loading: builtin + ~/.mma/certification/scenarios/*.yaml
├── fact-checker.ts # Pure check functions (path + content only)
├── runner.ts       # Orchestrator: scenario × N reps → subprocess MMA → fact-check → M/N tally
├── manifest.ts     # Read/write <project>/certification/certifications.json, staleness by mmaVersion
└── cli.ts          # Handlers for mma model certify / cert-status / cert-list / uncertify
```

### Data flow (one scenario)

1. Create a fresh sandbox at `<project>/.mma/certification/run-<id>/` (dev runs use `_testing/cert-<case>/`).
2. Copy any `fixtures` declared in the scenario into the sandbox.
3. Spawn `bun run mma --exit-on-complete --no-agents-md -d <sandbox> --model <name> --provider-url <url> --provider-key <key> <prompt>`.
4. Wait for exit; run all `checks` of the scenario against the sandbox.
5. Repeat N times; record `passed: k, of: n`.
6. Scenario = **pass** if `k >= m` (passThreshold), else **fail**. Scenarios with `mode: skip` are skipped, never failed.

### Data flow (checkmark)

`mma model list` / REPL `/model` → `provider.listModels()` → for each `m`: lookup manifest by `(m, config.provider.baseUrl)` → `✔` if entry exists and `mmaVersion` matches current, `○` (dim) if entry exists but MMA version is older, `·` if not certified.

## Scenario Format

Scenarios are declarative YAML. Built-in ones live in `scenarios.ts` as typed objects; user-defined ones in `~/.mma/certification/scenarios/*.yaml`.

```yaml
id: 2.2-create-file
title: Create single file
tags: [core]              # core | security | image | network | browser
mode: run                 # run | skip (interactive / non-headless → skip, not fail)
prompt: |
  Create a file hello.ts with content: export const msg = "Hello, MMA!";
reps: 3                   # N repetitions (per-scenario override)
passThreshold: 2          # M successful reps required for pass
checks:
  - type: fileExists
    path: hello.ts
  - type: fileContent
    path: hello.ts
    contains: 'export const msg = "Hello, MMA!"'
```

Defaults in `types.ts`: `reps: 3`, `passThreshold: 2`.

### Fixtures

Some scenarios need files to exist in the sandbox **before** the agent starts (e.g., image scenarios need a test image for `attach_image`). The `fixtures` field declares files to pre-copy:

```yaml
id: 12.1-attach-image
title: Attach image from file
tags: [image]
mode: run
prompt: |
  Use the attach_image tool to load test.jpg, then create description.txt with your description of the image.
fixtures:
  - source: docs/testing/fixtures/test.jpg   # relative to MMA project root
    dest: test.jpg                            # relative to sandbox
checks:
  - type: fileExists
    path: description.txt
```

The runner copies each fixture into the sandbox before spawning MMA. Source is relative to the MMA project root (where `bun run mma` is invoked). If a source is missing, the scenario fails with a clear error at the setup step (before any LLM calls).

### Check types (`fact-checker.ts`, pure functions)

| type | params | semantics |
|------|--------|-----------|
| `fileExists` | `path` | file exists |
| `fileNotExists` | `path` | file does not exist (delete/move scenarios) |
| `dirExists` | `path` | directory exists |
| `fileContent` | `path`, `contains` / `equals` | substring or exact match |
| `fileRegex` | `path`, `pattern` | regex over file content |
| `exitCode` | `code` (default 0) | agent process exit code |

Rules:
- A rep passes only if **all** checks in it pass (AND semantics).
- Check paths are **relative to the sandbox** — single source of truth, no races with agent paths.
- A scenario without `checks` is a loader validation error.

## Suites (tags)

Separate suites so expensive/networked scenarios can be excluded:

| tag | covers | notes |
|-----|--------|-------|
| `core` | file ops, multi-step/plan, skills, project-map, memory | default, no external dependencies |
| `security` | security scenarios | separate suite; **pre-check**: fails fast with a hint if `security.enabled === false` (user must run `mma security set-policy balanced` / `enable-*` first) |
| `image` | vision, `attach_image` (file/URL/clipboard) | separate |
| `network` | `web-search`, `web-fetch` | separate |
| `browser` | Playwright browser scenarios | separate |

Selection via `--tags core` (fast run), `--tags core,network`, etc.

### Porting `docs/testing/scenarios.md`

- Scenarios 2.x (files) and 3.x (multi-step with plan) → `core`.
- 1.3 (`web-search`/`web-fetch`) → `network`; 1.9, 1.10 (`browser`) → `browser`.
- 1.1, 1.2 (`question`/`approve`, removed tools) → `mode: skip` with a comment.
- 4.x (security) → `security`.
- 12.x (image) → `image`.
- 1.4–1.6 (project-map), 1.7/1.8 (skills), 1.11 (subagent), 1.12 (pipeline) → `core`.

## CLI

### New agent-run override flags

The harness must run MMA on an arbitrary (model, provider) without touching the user config:

```
bun run mma "<prompt>" --model <name> --provider-url <url> --provider-key <key> [--context-window N]
```

These override `config.model` / `config.provider.*` only for that run (in `bootstrap()`).

### New commands

```bash
mma model certify <name> [--provider-url <url>] [--provider-key <key>] [--tags core,security,...] [--reps N] [--clean]
mma model certify <name> --force                 # re-run an existing entry
mma model cert-status <name>                     # single entry: model | provider | suite | date | MMA version | per-scenario results
mma model cert-list                              # all entries from ~/.mma/certifications.json (table)
mma model uncertify <name>                       # remove an entry
```

`--tags` defaults to `core` when omitted. `--reps N` sets the **default** repetition count for scenarios that do not override `reps` in their own definition (per-scenario `reps` always wins).

`--clean` removes all sandbox directories after a successful run (default: keep them for debugging).

`mma model certify` without `--provider-url` uses the current `config.provider.baseUrl` (certifying the local pair).

### Progress reporting

During a cert run the runner prints live progress:

```
[1/12] 2.2-create-file (1/3)... pass
[1/12] 2.2-create-file (2/3)... pass
[1/12] 2.2-create-file (3/3)... pass  ← scenario pass
[2/12] 2.3-create-dir (1/3)... fail
[2/12] 2.3-create-dir (2/3)... pass
[2/12] 2.3-create-dir (3/3)... pass  ← scenario pass (2/3 ≥ 2)
...
Suite complete: 10 pass, 1 fail, 1 skipped (12 total)
```

Each rep prints its result immediately; when all reps complete, the scenario verdict is shown.

## Manifest

`~/.mma/certifications.json` — stored globally (certificate is about the environment, not the repo).

```json
{
  "version": 1,
  "certifications": [
    {
      "model": "qwen3.5-9b",
      "providerUrl": "http://localhost:8080",
      "mmaVersion": "0.22.0",
      "certifiedAt": "2026-08-05T10:00:00Z",
      "suite": { "passed": 14, "failed": 1, "skipped": 3, "total": 18 },
      "results": [
        { "id": "2.2-create-file", "status": "pass", "passed": 3, "of": 3 },
        { "id": "3.1-calculator", "status": "fail", "passed": 1, "of": 3 }
      ]
    }
  ]
}
```

- Dedup key: `(model, providerUrl)` — re-certifying replaces the entry.
- `uncertify` removes by `(model, providerUrl)`.

## Checkmark and Staleness

- `✔` — entry exists, `mmaVersion` matches current.
- `○` — entry exists but `mmaVersion` is older (dim; hint "run `mma model certify --force`").
- `·` — not certified.

Shown in `mma model list` and REPL `/model` (next to the existing `* ` current-model marker). Symbols are not strings, but all hints/labels go through `t()`.

## Error Handling and Flake Control

- **Provider unreachable** (connection refused / 401) → whole run stops, scenario gets `status: error`, reason recorded. Never "pass" on error.
- **Agent crashed** (exit ≠ 0) → rep counts as failed, but retries continue; fact-checker still inspects the sandbox (agent may have created files before crashing).
- **No scenarios matched** (`--tags core` finds nothing) → fail fast with the list of available tags.
- **Scenario without checks** → loader validation error, not runtime.
- **Required dependency missing** (network/security for a chosen suite) → pre-check with a clear message.
- **`error` ≠ `fail`**: infrastructure errors do not count toward `failed` in the suite stats — otherwise an offline rerun would "de-certify" a model.
- One failed scenario does not abort the run; the suite continues and reports fully.
- Per-rep timeout in the runner (~120s, matching the exec-tool limit) with a hang counter.

## Tests (vitest)

- `fact-checker.test.ts` — every check function: file exists/not, content contains/equals, regex, relative paths.
- `loader.test.ts` — YAML parsing, `reps`/`passThreshold` defaults, validation (empty checks, unknown type, unknown tag).
- `manifest.test.ts` — read/write, `isStale()` (mmaVersion match), dedup by `(model, providerUrl)`, `uncertify`.
- `runner.test.ts` — M/N tally with a mocked fact-checker: 2/3 → pass, 1/3 → fail, error vs fail distinction.
- Integration: manual `mma model certify` run on `_testing/cert-<case>/` (same sandbox discipline as AGENTS.md).

## i18n

All user-facing strings (commands, hints, reports) go through `t()` — both `en.json` and `ru.json` must have matching keys (design rule #8).

## Versioning

New functionality (commands, flags, module) → **MINOR** bump to **0.23.0**.

## Out of Scope (future)

- Interactive scenarios via a live stdin channel.
- Cost/budget tracking per certification run.
- "Certified on this backend" auto-detection on provider selection (`scope_request`-style flows).
