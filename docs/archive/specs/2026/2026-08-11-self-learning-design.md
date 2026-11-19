# Self-Learning Module Design

**Date:** 2026-08-11
**Status:** Draft (pending review)
**Author:** pi agent (brainstorming with user)

## References

- **Self-Harness** (arxiv 2606.09498) — iterative loop: Weakness Mining → Harness Proposal → Proposal Validation (regression-tested). Pass rates +33–60% on Terminal-Bench-2.0. Agent improves its own harness, not model weights.
- **Hermes Agent** (Nous Research) — what Hermes calls self-learning: bounded memory (MEMORY.md/USER.md), session search, skills as SKILL.md files created after successful workflows, periodic "nudge" reviewing recent dialogues and extracting reusable patterns.
- **Harness Engineering** (qcode, habr) — `Agent = Model + Harness`. Self-learning is a feedback loop that rebuilds the harness.

## Problem

MMA's improvement loop is manual and unsystematic (literature.md gap: "Improvement is manual, not systematic"). The agent has all the substrates — session traces (`session.jsonl`), memory (`remember`/`recall`, `appendRule`), skills (progressive disclosure L1/L2/L3), regression harness (`mma model certify`) — but no loop connecting them.

## Constraints (small models, 9B)

1. **Errors are many** — naive "learn from every error" eats context and self-corrupts (the "Agent Memory Broke" loop). Phase 2 must be selective and bounded.
2. **1 LLM call per nudge** — budget discipline. Trace compaction is deterministic (no LLM).
3. **No heuristics** — model decides success/complexity via system prompt (AGENTS.md rule #10).
4. **Opt-in** — `learning.enabled: false` by default, like `security`.

## Scope Decision

- **Phase 1 (implement):** successes → skills (Hermes-style). `mma learn` CLI + auto-suggestion directive.
- **Phase 2 (design only, not implemented):** gated error learning (Self-Harness-style), frequency gate ≥3, regression validation.

## Phase 1 Architecture

### Files

```text
src/modules/learning/
├── types.ts        # LearningConfig, TraceSummary, SkillDraft, ValidationResult
├── trace.ts        # TraceReader — deterministic compact trace (NO LLM)
├── generator.ts    # SkillGenerator — 1 LLM call → SKILL.md draft
├── validator.ts    # SkillValidator — deterministic draft checks
└── module.ts       # LearningModule — AgentModule: system prompt directive
```

Modifications:

| File | Change |
|---|---|
| `src/config/types.ts` + `src/config/defaults.ts` | `learning` config section |
| `src/cli/commands.ts` | `mma learn` subcommand |
| `src/i18n/en.json` + `src/i18n/ru.json` | strings (rule #8) |
| `tests/modules/learning/*.test.ts` | tests |

### Config

```typescript
interface LearningConfig {
  enabled: boolean;            // default false
  skillGeneration: {
    minToolCalls: number;      // 3 — complexity threshold for nudge
    minLength: number;         // 200 chars
    maxLength: number;         // 3000 chars
    targetDir: 'project' | 'global';  // default save location
  };
  nudge: { enabled: boolean };
}
```

### Components

1. **TraceReader** (`trace.ts`) — deterministic, no LLM.
   - Input: session id → `SessionStore.loadSessionLog(id)` (existing).
   - Output: `TraceSummary { steps: [{tool, action, status, error?}], errors: string[], toolCallCount }`.
   - Compaction: tool name + summarized args (truncated), status + first error line. Full content never read — budget protection.

2. **SkillGenerator** (`generator.ts`) — 1 LLM call via the existing provider layer (same factory as the agent, retries 3×1/2/4s).
   - Prompt: compact trace + "extract reusable procedure: when to use, step-by-step, what to avoid. Output SKILL.md with frontmatter (`name`, `description`, `when_to_use`, `mma_version: 2`)".
   - Output: `SkillDraft { name, content }`.

3. **SkillValidator** (`validator.ts`) — deterministic:
   - frontmatter parses; `name` slug ≤40 chars; `description` ≥10 chars; body length between min/max;
   - duplicate-name check against existing skills (builtin/global/project via existing `SkillsLoader`);
   - garbage patterns (body = markdown heading, checkbox fragment — same idea as MemoryValidator).

4. **LearningModule** (`module.ts`) — `AgentModule`:
   - `getSystemPromptBlock()` returns unconditional directive (~40 tokens): "If this session produced a reusable procedure, suggest saving it as a skill: name + one-line description in your final answer. Do NOT create files or call save tools — the user runs `mma learn`."
   - No success heuristics — the model decides.

## Phase 1 Data Flow

```text
AUTO-SUGGESTION (in-session):
  system prompt directive → agent final answer: "This is a reusable procedure — save it as a skill? Run `mma learn`"

NUDGE (mma learn):
  1. CLI resolves session (last by default, --session <id> override)
  2. TraceReader: session.jsonl → TraceSummary (~500-800 tokens)
  3. [exit 0, no LLM] if toolCallCount < minToolCalls → "Nothing to learn"
  4. SkillGenerator: 1 LLM call → SKILL.md draft
  5. Show draft to user (boxed, ui/renderer) → confirm y/n
  6. SkillValidator: checks, warnings/errors surfaced
  7. Save: .mma/skills/<name>.md (project) or ~/.agents/skills (--global)
   - Resolution order: config `learning.skillGeneration.targetDir` (default `'project'`) → CLI `--global` flag overrides to global. Explicit `--project` flag not needed; `targetDir` + `--global` cover both.
  8. "Skill saved: <name>" — immediately available via existing SkillsLoader (L1)
```

## Error Handling

| Case | Behavior |
|---|---|
| Session not found / invalid `--session` | Clear error, exit 1 |
| `toolCallCount < minToolCalls` | "Nothing to learn", exit 0, zero LLM tokens |
| LLM call fails | Existing retries (3×1/2/4s), then error with retry advice |
| Draft fails validation | Show errors, offer regenerate / abort |
| Duplicate name | Suggest rename or abort — never overwrite existing skill |

## Testing (TDD, rule #7)

- `trace.test.ts` — fixture `session.jsonl` → expected `TraceSummary` (compaction, error truncation)
- `validator.test.ts` — frontmatter / length / duplicate / garbage patterns
- `generator.test.ts` — mocked LLM response → `SkillDraft` (parsing)
- Integration — `mma learn --session <fixture>` in `_testing/`, i18n key parity

## Phase 2 Sketch (design only, NOT implemented)

- **Weakness mining** over error-laden traces → failure classification (context/constraint/verification/planning — literature gap #5)
- **Frequency gate ≥3** repeats → a lesson is considered
- **Proposals:** bounded memory entries via existing `appendRule(pattern, cause, solution)` + config threshold tweaks
- **Validation:** MemoryValidator (from the quality-gate plan) + regression via certification scenarios (`mma model certify`)
- **Budget:** `errors.md` capped at 50 entries + TTL, progressive disclosure, top-5 by frequency in system prompt
- **Rollback:** `harness-changes.jsonl` log

## Open Questions (resolve at implementation)

1. Provider factory reuse from CLI context — exact instantiation path in `bootstrap.ts` (same pattern as certification runner's env-override spawn vs direct factory call).
2. Where `mma learn` lives in `commands.ts` (subcommand group) — match existing `session`/`model` structure.
3. SkillsLoader invocation from the CLI to get the existing-skill name set for duplicate checks.
