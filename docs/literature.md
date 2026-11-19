# Literature: Agent Harness Engineering

> Compilated 2026-08-11. Sources on best practices for building production-ready AI agent harnesses.

---

## Sources

| # | Title | Author / Org | Date | URL |
|---|-------|-------------|------|-----|
| 1 | Harness Engineering Best Practices from Anthropic and OpenAI | celesteanders (gist) | Apr 2026 | https://gist.github.com/celesteanders/21edad2367c8ede2ff092bd87e56a26f |
| 2 | How to Build a Custom Agent Harness | Sydney Runkle / LangChain | Jun 2026 | https://www.langchain.com/blog/how-to-build-a-custom-agent-harness |
| 3 | Harness, Scaffold, and the AI Agent Terms Worth Getting Right | Sergio Paniego, Aritra Roy Gosthipaty / HuggingFace | May 2026 | https://huggingface.co/blog/agent-glossary |
| 4 | Harness Engineering: How to Build Reliable AI Agents | deepset Team | May 2026 | https://www.deepset.ai/blog/harness-engineering |
| 5 | Harness engineering for coding agent users | Birgitta Böckeler / Martin Fowler | Apr 2026 | https://martinfowler.com/articles/harness-engineering.html |
| 6 | Having a hard time trying to find the ideal 9B model | r/LocalLLaMA | Aug 2026 | https://www.reddit.com/r/LocalLLaMA/comments/1hw6dt3/ |
| 7 | Tool calling issues Qwen 3.5 9B | Stoiker / Turnstone #186 | Mar 2026 | https://github.com/turnstonelabs/turnstone/issues/186 |
| 8 | Tool call stops in middle of conversation (Qwen3.5-9B) | TechCarbasa / HuggingFace | Mar 2026 | https://huggingface.co/Qwen/Qwen3.5-9B/discussions/10 |
| 9 | Agent Memory Broke — A Day of Wrestling with a 9B Model | shimo4228 / Zenn | Mar 2026 | https://zenn.dev/shimo4228/articles/few-shot-for-small-models |

*Source #6 (Medium) was inaccessible (403).* Source #9 (AI StackExchange) was inaccessible (403).

---

## Small Model Engineering Principles (9B and below)

Sources: [6] r/LocalLLaMA, [7] Turnstone #186, [8] HuggingFace Qwen3.5-9B, [9] Zenn/shimo4228.

### Cross-source findings

| # | Principle | Source | MMA Status |
|---|-----------|--------|------------|
| 1 | **Context is a finite resource** — every token competing with the task. Few-shot examples consume capacity. | [9] | ✅ Dynamic budget (10%/15%/75%), compaction at 75%, no few-shot |
| 2 | **Generation-time constraints consume capacity** — constrained decoding guarantees structure but kills content quality on 9B | [9] | ✅ Free generation + post-hoc JSON parse + non-streaming fallback |
| 3 | **Control at save time, not generation time** — deterministic validation after generation is cheaper than controlling generation | [9] | ✅ Hallucination pipeline + stuck detector + plan enforcement + memory quality gate |
| 4 | **One task per call** — single LLM call that must extract AND format is too heavy for 9B | [9] | ✅ 6-layer state machine, each phase one responsibility |
| 5 | **Self-reinforcing memory corruption** — garbage in persistent memory → context → more garbage loop | [9] | ✅ MemoryValidator (planned, Task 6 in quality gate plan) |
| 6 | **Empty responses on multi-turn** — Qwen3.5-9B returns `finish_reason=stop, tool_calls=0, content=''` mid-task | [7][8] | ✅ Non-streaming fallback + ConfidenceCheck retry |
| 7 | **Custom Jinja templates fix tool calling** — default templates on llama.cpp break tool_call parsing | [7][8] | ✅ Explicit `stream: false` + `type: "function"` in tool_calls |
| 8 | **Streaming fallback always needed** — some models don't stream JSON tool_calls via `delta` | [8] | ✅ `doStream` → empty → `doNonStreaming` fallback |

### Known 9B limitations not yet addressed

| # | Limitation | Source | Mitigation needed |
|---|-----------|--------|-------------------|
| 1 | **Constrained decoding quality trade-off** — JSON Schema enforcement produces valid but empty content | [9] | Already avoided; document as principle |
| 2 | **Few-shot counterproductive** — adding examples squeezes task understanding capacity | [9] | Already avoided; document as principle |
| 3 | **Tool calling parsing breaks** — tool_calls field missing or malformed in streaming | [7][8] | Non-streaming fallback handles this |
| 4 | **"continue" nudges needed** — model stops mid-task, user must send "continue" | [8] | ConfidenceCheck + auto-retry on empty responses |

---

## Core Definition

**Agent = Model + Harness** — the harness is everything except the model: tools, memory, guardrails, verification, orchestration. (LangChain, HuggingFace, deepset all converge on this.)

Böckeler narrows it for coding agents: an inner harness (built into the coding agent via system prompt, retrieval, orchestration) and an outer harness (built by the user via AGENTS.md, skills, linters, tests).

---

## Key Principles (cross-source synthesis)

### 1. Architecture

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Multi-agent with separated concerns** (Planner / Generator / Evaluator) | [1] | Partial — MoE with Router + Experts, but no dedicated Evaluator agent |
| **Keep it monolithic until complexity demands otherwise** | [1] | ✅ Single-agent loop is default; MoE is opt-in |
| **Fresh context windows per session** (reset vs compaction) | [1] | ✅ ContextManager with sliding window + compaction |
| **Middleware pattern** — composable hooks into agent loop | [2] | ✅ Plugin system with lifecycle hooks (onBeforeThink, onAfterTool, etc.) |

### 2. State Management

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Persist state in structured files, not in context** | [1] | ✅ PlanStore (JSON), session JSONL, memory markdown |
| **JSON for task lists, not Markdown** (resists corruption) | [1] | ⚠️ Plans are JSON ✅, but memory files are Markdown (conventions.md, decisions.md) |
| **Repository as system of record** — if it's not in the repo, it doesn't exist | [1] | ⚠️ Skills are external (`~/.mma/skills/`); project-level `.mma/` is gitignored |
| **AGENTS.md as map, not encyclopedia** (~100 lines, progressive disclosure) | [1] | ❌ Current AGENTS.md is ~900+ lines — needs restructuring |

### 3. Session Protocol

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Consistent session lifecycle**: Orient → Setup → Verify → Select → Implement → Test → Update → Clean exit | [1] | ⚠️ No explicit "verify baseline" step at session start |
| **One task per session** to prevent context exhaustion | [1] | ⚠️ No enforcement; agent can attempt multiple tasks |
| **Verify before building** — run baseline checks first | [1] | ❌ No automatic baseline verification |

### 4. Feedback Loops & Backpressure

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Wire automated verification as backpressure** (lint, typecheck, tests) | [1] | ✅ lint-on-write plugin, tsc --noEmit, bun test |
| **Browser/UI automation for verification** | [1] | ✅ Playwright browser tool |
| **Evaluator with concrete grading criteria** | [1] | ❌ No evaluator agent; model self-rates |
| **Sprint contracts** — negotiate "done" before implementing | [1] | ⚠️ Plan steps are defined but no explicit "done criteria" negotiation |
| **Classify failures by layer** (context / constraint / verification / planning) | [4] | ⚠️ No structured failure classification |
| **Computational sensors** (deterministic, fast) vs **Inferential sensors** (AI review) | [5] | ✅ Computational: lint, tsc, tests. ❌ Inferential: no AI code review |

### 5. Context Window Management

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Treat context as scarce resource** | [1] | ✅ Context budget system (10%/15%/75% split) |
| **Offload expensive work to subagents** — primary context as scheduler | [1] | ✅ Subagent spawning with tool filtering |
| **Progressive tool disclosure** — don't load all tools upfront | [4] | ⚠️ Tool tags exist but all tools are registered; no progressive disclosure |
| **Deterministically load same core files each loop** | [1] | ⚠️ System prompt is built once per session, not per iteration |

### 6. Security & Sandboxing

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Defense in depth**: OS sandbox + filesystem restrictions + command allowlist | [1] | ✅ Security module: bash validation, path validation, network filtering, content scanning |
| **Three layers**: OS, filesystem, command allowlist | [1] | ✅ PathValidator, CommandValidator, NetworkValidator |

### 7. Code Quality

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Enforce invariants mechanically** (lint rules as code) | [1] | ✅ Custom lint rules, tsc strict mode |
| **Optimize for agent legibility** — boring tech, composable APIs | [1] | ✅ Bun + TypeScript, single-responsibility files |
| **Treat technical debt like garbage collection** — recurring cleanup | [1] | ❌ No recurring cleanup agents |
| **Make application inspectable** — DevTools, logs, metrics | [1] | ⚠️ Audit logging exists but no structured observability |
| **Harnessability** — codebase properties that make it governable | [5] | ✅ Strong typing, module boundaries, clear project structure |

### 8. Recovery & Resilience

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Git as safety net** — commit after every task, read history at session start | [1] | ⚠️ No automatic commit or git history reading |
| **Expect failures, plan for them** — reset vs rescue | [1] | ⚠️ Stuck detector exists but no automatic recovery strategy |
| **Regenerate plans periodically** — compare codebase vs spec | [1] | ⚠️ Plan re-plan exists but no automatic drift detection |

### 9. Evolving the Harness

| Principle | Source | MMA Status |
|-----------|--------|------------|
| **Re-evaluate harness complexity with each model upgrade** | [1] | ⚠️ No systematic re-evaluation process |
| **Start simple, add complexity only when needed** | [1] | ✅ MoE is opt-in, single-agent is default |
| **Harness as living system** — iterative improvement loop | [4] | ⚠️ Improvement is manual, not systematic |
| **Pipeline serialization as governance** — harness config in version control | [4] | ⚠️ Config is in code, not serialized YAML |

### 10. Terminology (HuggingFace glossary)

| Term | Definition | MMA Equivalent |
|------|-----------|----------------|
| **Scaffolding** | Behavior-defining layer: system prompt, tool descriptions, response parsing, context management | System prompt + tool registry + prompt builder |
| **Harness** | Execution layer: calls model, handles tool calls, decides when to stop | Agent loop (state machine in agent.ts) |
| **Context Engineering** | Designing what goes into the context window at each step | ContextManager + prompt-builder + skills |
| **Policy** | Behavior the agent follows: prompts + tools + memory + execution loop | Config + security policies + execution guarantees |
| **Skills** | Reusable structured packages of knowledge for multi-step tasks | Skills module with L1/L2/L3 progressive disclosure |
| **Sub-agents** | Agent called by another agent to handle a subtask | Subagent tool with scope isolation |

---

## Gaps Identified in MMA

### Critical

1. **AGENTS.md is too long** (~900 lines) — should be a map pointing to docs/, not an encyclopedia [1]
2. **No Evaluator agent** — model self-rates; need separate skeptical evaluator [1]
3. **No "verify before building" step** at session start [1]

### Important

4. **Memory files are Markdown** — JSON would be more corruption-resistant [1]
5. **No structured failure classification** — context / constraint / verification / planning [4]
6. **No recurring cleanup agents** for technical debt [1]
7. **No automatic baseline verification** at session start [1]
8. **No systematic harness re-evaluation** with model upgrades [1]

### Nice-to-have

9. **No inferential sensors** (AI code review) — only computational [5]
10. **No harness templates** for common project topologies [5]
11. **No automatic git history reading** at session start [1]
12. **No sprint contracts** — explicit "done criteria" before implementation [1]

### Small model specific (new)

13. **No memory quality gate** — `MemoryStore.append()` accepts garbage without validation [9]
14. **Small model principles not documented** — 4 principles from Zenn exist implicitly in code but not in AGENTS.md [9]

---

## Recommendations

### Short-term (next release)

1. **Restructure AGENTS.md** → keep ~150 lines as map, move details to `docs/` subdirectories
2. **Add "verify baseline" tool** — runs `tsc --noEmit` + `bun test` at session start
3. **Add failure classification types** to stuck-detector and audit outputs
4. **Add memory quality gate** — `MemoryValidator` with garbage/duplicate/length checks [9]
5. **Document small model engineering principles** in AGENTS.md [9]

### Medium-term

4. **Implement Evaluator agent** in MoE — separate model that reviews Generator output
5. **Add recurring cleanup skill** — scans for drift, suggests refactoring
6. **Convert memory files to JSON** (conventions.json, decisions.json, errors.json)

### Long-term

7. **Harness templates** — predefined configs for common project types (Node API, React SPA, etc.)
8. **Inferential sensors** — AI code review as optional plugin
9. **Automatic harness metrics** — track failure rates, token usage, iteration counts

---

*This document should be updated as new literature is reviewed and gaps are addressed.*
