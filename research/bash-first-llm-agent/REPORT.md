# Bash-First LLM Agent: Architecture, Safety, and Small Model Patterns

> Generated 2026-07-16 · depth: deep · 47 unique sources · workspace: research/bash-first-llm-agent/

## Executive Summary

- **Bash-first is validated at scale**: Vercel's d0 agent achieved 3.5x faster execution, 100% success rate, and 37% fewer tokens by stripping all specialized tools and using bash-only access [3][1]. The architecture works.
- **Code-based actions outperform JSON tool calling by up to 20%** across 17 LLMs in the CodeAct paper — the strongest empirical validation for bash-first agents on small models [8].
- **9B models hit a "structure tax"** — forcing JSON+code dual-format generation causes cascading syntax errors. Bash/plain code output is optimal, not JSON function calling [1][7].
- **Claude Code's bash architecture** provides a production-grade reference: isolated processes, 2-min timeout, 30K char output truncation with file overflow, read-only command allowlist, compound command parsing, and bubblewrap sandboxing [1-12 in F1].
- **OpenCode's tool system** shows an alternative: Effect-TS-based `Tool.define()` with Schema validation, lazy registry, permission gating (allow/ask/deny), and automatic output truncation [1-12 in F2].
- **Safety requires defense-in-depth**: bubblewrap (Linux) / sandbox-exec (macOS) for isolation + regex dangerous command detection with NFKC normalization + env var scrubbing + network whitelisting [1-12 in F4].
- **Small models know the root binary but fail on syntax** — NVIDIA showed grammar-constrained decoding improved Qwen3-0.6B from 16.7% to 59.2% pass rate on bash tasks [3].
- **Context engineering is critical**: "Lost in the Middle" means system prompts and tool results must be at context edges; too much irrelevant context actively harms small model performance [5,7].

## Background & Scope

This research investigates how to build a "bash-first" LLM agent — one that uses shell commands as its primary (or sole) tool — targeting 9B parameter models like Qwen3.5-9B with 32K-64K context windows. The investigation covers existing implementations (Claude Code, OpenCode, Hermes Agent), empirical evidence for bash-first architecture, safety patterns, and small-model-specific techniques. Time frame: 2024-2026.

## 1. How Claude Code Structures Its Bash Tool

Claude Code is the most mature production implementation of a bash-first agent tool. Its architecture provides concrete patterns:

### Process Isolation
Each command runs in an **isolated process** — environment variables do not persist between commands. Only the working directory carries over within the main session [F1:1]. Subagents never inherit working directory changes [F1:9]. Shell startup files (~/.zshrc, ~/.bashrc) are sourced at session start to capture aliases and functions, then applied to every command [F1:10].

### Timeout Handling
Default **2-minute timeout** per command, configurable up to 10 minutes via `timeout` parameter. Override defaults with `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` env vars [F1:2].

### Output Truncation
- Default cap: **30,000 characters**
- Overflow: full output saved to a file in the session directory; Claude gets the file path + short preview
- Hard ceiling: **150,000 characters** via `BASH_MAX_OUTPUT_LENGTH`
- Claude can then `read` or `search` the saved file for remaining content [F1:3]

### Permission System
- **Built-in read-only allowlist**: ls, cat, echo, pwd, head, tail, grep, find, wc, which, diff, stat, du, cd, and read-only git forms — runs without permission prompts [F1:4]
- **Compound command parsing**: &&, ||, ;, |, |&, &, newlines are recognized; each subcommand is independently permission-checked [F1:5]
- **Process wrapper stripping**: timeout, time, nice, nohup, stdbuf are stripped before rule matching so rules apply to the inner command [F1:6]
- **Semantic exit codes**: exit code 1 from grep/git-grep means "no matches found" not failure; exit code 1 from git diff means "differences exist" [F1:7]

### Sandboxing
- macOS: **Seatbelt** (sandbox-exec)
- Linux/WSL2: **bubblewrap** (~50KB binary, runs without root)
- Filesystem restricted to working directory by default
- Network proxy for domain allowlisting [F1:8]

### Hooks
PreToolUse hooks receive JSON on stdin, can block (exit 2), force prompt, or skip prompt. Enables programmatic command validation [F1:11].

### Background Execution
`run_in_background: true` parameter lets long-running processes (dev servers, watch builds) continue while Claude works on other tasks [F1:12].

## 2. OpenCode's Tool System

OpenCode (anomalyco/opencode) takes a different architectural approach — a typed, Effect-TS-based tool system:

### Tool Definition Pattern
```typescript
// Core interface
interface Def<Parameters, M extends Metadata> {
  id: string;
  description: string;
  parameters: Parameters;  // Effect Schema decoder
  jsonSchema?: JSONSchema7;
  execute(args, ctx: Context): Effect<ExecuteResult<M>>;
}

// Definition via Tool.define()
Tool.define(id, init: Effect<Init<Parameters, Result>, never, R>)
```
Parameters use `Schema.Struct` with `.annotate()` for LLM-facing descriptions [F2:1,2,4].

### Registry Architecture
- **Lazy initialization**: tools created on first access
- **Filtering**: by provider, model, and agent permissions before returning final tool list
- **Schema decoding**: args validated through Effect Schema; errors become `InvalidArgumentsError` for LLM retry [F2:5,6]

### Permission Gating
Three states: **allow / ask / deny** using glob-pattern matching on tool names. Last-match-wins evaluation order. Per-agent overrides available [F2:11].

### Output Handling
Automatic truncation via a `Truncate` service; truncated output saved to file with path provided to model [F2:9].

### Custom Tools
Place `.ts/.js` files in `.opencode/tools/` or `~/.config/opencode/tools/`. Use Zod-based `tool()` helper from `@opencode-ai/plugin`. Tool descriptions live in companion `.txt` files separate from implementation [F2:8,10].

### Key Design Lesson
OpenCode separates tool description text from code (`.txt` files), keeps schema definitions co-located with implementation, and uses a typed middleware pattern rather than ad-hoc string parsing.

## 3. Bash as Universal Interface

### The Core Argument
LLMs output text natively. They ingested billions of lines of bash scripts during training. They already understand stdout, pipes, and redirects. JSON function calling forces models to manage complex schemas that add thousands of tokens of overhead and lead to syntax hallucinations [F3:2,4].

### Empirical Evidence

| Source | Finding | Metric |
|--------|---------|--------|
| Vercel d0 agent [F3:1] | Bash-only vs specialized tools | 3.5x faster, 100% success, 37% fewer tokens |
| NVIDIA grammar study [F3:3] | Grammar-constrained bash generation | 16.7% → 59.2% (Qwen3-0.6B) |
| CodeAct paper [F7:8] | Code-based vs JSON actions across 17 LLMs | Up to 20% higher success rate |
| NVIDIA overall [F3:7] | Grammar constraints across 13 small models | 62.5% → 75.2% average pass rate |

### Why It Works for Small Models
- **No schema tax**: one tool definition vs. dozens of function schemas eliminates ~90% of prompt token overhead [F5:2]
- **Training data alignment**: 50+ years of Unix tool development means bash is well-represented in LLM training data [F3:6]
- **Composition via pipes**: natural text composition mirrors how LLMs process information [F3:5]
- **Unix philosophy alignment**: "Each tool should do one thing and do it well" — text as universal interface [F3:5,8]

### Tradeoffs
| Advantage | Disadvantage |
|-----------|-------------|
| Minimal prompt tokens | Security risk requires heavy sandboxing [F3:12] |
| Natural for LLMs | Small models fail on syntax细节 (quoting, control operators) [F3:3] |
| Infinite composition via pipes | Shell composition multiplies state space [F3:7] |
| No schema management | No structured output guarantees |
| Leverages training data | Error messages from shell are often cryptic |

## 4. Safety Patterns for Bash Execution

### Defense-in-Depth Architecture

**Layer 1 — OS-Level Sandbox**
- **bubblewrap (bwrap)**: dominant choice, ~50KB binary, runs without root using CLONE_NEWUSER namespaces [F4:1]
- Claude Code uses bubblewrap on Linux, sandbox-exec on macOS [F4:2]
- **gVisor**: user-space kernel for stronger isolation via syscall interception [F4:10]
- **Nix sandbox**: declarative security with package-level tool restrictions — agent only sees approved binaries [F4:9]

**Layer 2 — Command Detection**
- Regex-based dangerous command detection with patterns for: `rm -rf`, `sudo`, `chmod 777`, `git push --force` [F4:11]
- **NFKC normalization** required to prevent homograph bypasses using Unicode lookalike characters [F4:3]
- Hermes Agent: hardline blocklist that cannot be bypassed even in YOLO mode [F4:6]

**Layer 3 — Permission Gating**
- Claude Code: command-based and prompt-based validation hooks [F4:4]
- OpenCode: pattern-based allowlist/blocklist with last-match-wins [F4:5]
- Three-state model (allow/ask/deny) with glob patterns [F4:5]

**Layer 4 — Environment Hygiene**
- Scrub all API keys and secrets from child process environment [F4:12]
- Filesystem restricted to working directory [F1:8]
- Network whitelisting via DNS proxy [F4:7]

### Implementation Patterns for MMA

```
Recommended safety stack for Node.js bash-first agent:
1. Spawn via child_process with:
   - Timeout (default 120s, max 600s)
   - Environment scrub (only pass whitelisted vars)
   - Working directory confinement
2. Output truncation (default 30K chars, save overflow to file)
3. Regex blocklist for destructive commands (rm -rf, mkfs, dd, etc.)
4. Exit code semantic mapping (grep=1 → not failure)
5. Optional: bubblewrap sandbox for production
```

## 5. Context-Efficient Tool Design for Small Models

### Token Budget Analysis

A single `bash` tool definition consumes approximately:
- Tool name: ~5 tokens
- Description (2-3 sentences): ~50-80 tokens
- **Total: ~60-85 tokens**

Compare to 10 function-calling tools with JSON schemas:
- Each tool: name + description + parameter schema
- Typical: ~200-500 tokens per tool
- **Total: ~2000-5000 tokens**

**Savings: ~95% reduction in tool definition overhead** [F5:2,11]

### Tool Result Formatting

Anthropic's guidance: keep formats close to natural text patterns the model was trained on [F5:1]. For bash output:
- Return stdout/stderr as-is (no JSON wrapping)
- Truncate with clear marker: `[OUTPUT TRUNCATED — 347 lines, saved to /path/to/file]`
- Prepend exit code on non-zero: `[EXIT CODE: 1]\n<output>`
- Keep error messages concise and actionable

### When to Use Bash vs Structured Tools

| Use Bash When | Use Structured Tools When |
|---|---|
| Model is <15B parameters | Model has reliable function calling |
| Task is file/shell operations | Task needs structured data (API calls) |
| Composition needed (pipes) | Single-shot atomic operations |
| Token budget is tight | Output needs guaranteed schema |
| Training data covers the commands | Domain is niche/undocumented |

### Multi-Step Tool Chains

Programmatic/batch tool calling bypasses the context window for intermediate results, saving ~10x tokens [F5:5,9]. For bash-first agents:
- Single bash command can chain operations: `cd dir && grep -r "pattern" && wc -l`
- Avoid putting full output of step N into context before step N+1
- Summarize intermediate results to 2-3 sentences

## 6. Agentic Loops and Prompt Patterns

### The Canonical Loop

```
User Query → Context Assembly → LLM Decision → Tool Execution → Observation → Repeat
```

Where Context Assembly = System Prompt + Tool Definitions + Message History [F6:2].

### ReAct Pattern
Thought → Action → Observation interleaved [F6:1]. For bash-first agents, the pattern simplifies to:

```
Thought: I need to find all TODO comments in the codebase.
Action: bash
Command: grep -rn "TODO" src/
Observation: src/index.ts:42: // TODO: implement error handling
src/utils.ts:15: // TODO: add validation
Thought: Found 2 TODOs. Let me read the surrounding context.
Action: bash
Command: sed -n '40,45p' src/index.ts
...
```

### Prompt Architecture (Layered)

1. **System Layer**: Agent identity, capabilities, behavioral rules
2. **Task Layer**: Current task instructions
3. **Tool Layer**: Tool description (bash: what it does, constraints, examples)
4. **Memory Layer**: Historical context from previous steps [F6:6]

### Key Prompt Patterns for Bash-First Agents

**Tool description must include WHEN to use, not just WHAT:**
```
bash: Execute shell commands. Use this for ALL file operations, code search,
running tests, building, git operations, and any system interaction.
Do NOT use for: reading files directly (use read tool), editing files (use edit tool).
```

**Error recovery instructions are critical:**
```
If a command fails:
1. Read the error message carefully
2. Check if it's a permission issue, missing file, or syntax error
3. Fix the command and retry
4. If stuck, try: ls to verify directory, which <tool> to verify availability
```

**Sparse thoughts for action-heavy tasks** — ALFWorld/WebShop examples show minimal thinking between action steps [F6:8].

## 7. Working with 9B Models Specifically

### Known Limitations

**Structure Tax** [F7:1]:
- 7B/9B models struggle to simultaneously handle JSON formatting + code syntax + problem-solving
- The cognitive overhead of structured generation overwhelms models that would otherwise perform well
- **Solution**: bash-first eliminates the JSON overhead entirely

**Cascading Parse Errors** [F7:2]:
- First-call parsing errors reduce success by 21.3%
- Small models error-recover poorly from malformed output
- **Solution**: keep output format simple; pre-fill assistant responses

**Lost in the Middle** [F7:5]:
- Performance highest at beginning/end of context, degrades in the middle
- **Solution**: place system prompt first, critical tool results at edges

**Context Window Limits** [F7:9]:
- Aider warns when >4 files or >20K tokens combined
- Too much irrelevant context actively hurts small models
- **Solution**: keep context lean; summarize aggressively

**Qwen3 Thinking Mode Issues** [F7:11]:
- reasoning_content fields may be dropped in multi-step tool interactions
- Multi-step tool use quality may be suboptimal with thinking enabled
- **Solution**: consider disabling thinking mode for tool-heavy workflows

### Techniques That Help

| Technique | Impact | Source |
|-----------|--------|--------|
| Grammar-constrained decoding | 16.7% → 59.2% (0.6B model) | NVIDIA [F3:3] |
| Pre-filling response prefix | Dramatically improves instruction following | HuggingFace [F7:7] |
| Code-based actions vs JSON | Up to 20% higher success | CodeAct [F7:8] |
| Correct chat template | "Drastically worse performance" if wrong | Qwen [F7:3] |
| DSPy automated prompts | 65% improvement over manual few-shot | DSPy [F7:12] |
| Knowledge distillation training | 9B matches 2-3x larger models | Gemma 2 [F7:6] |

### Recommended Model Choice
**Qwen2.5-Coder-7B** (or Qwen3 equivalent): 5.5T training tokens, 128K context, competitive with 2-4x larger models. Improved JSON generation and resilience to system prompt diversity [F7:3,10].

## Comparison Table: Agent Framework Approaches

| Aspect | Claude Code | OpenCode | Bash-First (MMA target) |
|--------|------------|---------|------------------------|
| Tool count | Multiple (Bash, Read, Edit, etc.) | Multiple (Bash, Read, Edit, etc.) | Single (bash) |
| Schema approach | Built-in schemas | Effect Schema | Natural language description |
| Sandboxing | bubblewrap / Seatbelt | Permission gating | bubblewrap + regex blocklist |
| Output handling | 30K char cap + file overflow | Truncate service + file | 30K char cap + file overflow |
| Permission model | Allowlist + compound parsing | Glob-pattern allow/ask/deny | Allowlist + blocklist |
| Timeout | 2 min default, 10 min max | Configurable | 2 min default, 10 min max |
| Target model size | Claude (large) | Various | 9B (Qwen3.5) |

## Recommendations for MMA Implementation

### Architecture
1. **Single `bash` tool** — one tool definition, ~60 tokens in prompt
2. **Plus `read` and `edit` tools** — for direct file operations without shell overhead
3. **ReAct-style loop** with sparse thoughts for action-heavy tasks

### Safety Stack
1. Process isolation via `child_process.spawn` with env scrubbing
2. Timeout: 120s default, 600s max
3. Output truncation: 30K chars default, file overflow
4. Regex blocklist: rm -rf, sudo, chmod 777, mkfs, dd, curl|sh
5. NFKC normalization on commands before regex matching
6. Semantic exit codes (grep=1 → not failure)

### Prompt Design
1. System prompt at context start (combat Lost in the Middle)
2. Tool description: "bash: Execute shell commands for ALL system interaction"
3. Include 2-3 bash examples in the tool description
4. Error recovery instructions in system prompt
5. Pre-fill assistant response with `Thought:` to guide ReAct pattern

### Output Format
```
[EXIT: 0]                    ← only on non-zero
<stdout content>             ← raw, no JSON wrapping
[TRUNCATED: 347 lines → /tmp/mma-output-xxx.txt]  ← on overflow
```

## Open Questions

1. **Grammar-constrained decoding**: Can we implement NVIDIA's approach at inference time with Ollama/vLLM? What's the latency cost?
2. **Pre-filling strategy**: Does pre-filling with `Thought:` or `bash\n` improve Qwen3.5-9B command generation?
3. **Context budget profiling**: At what token count do 9B models start failing on multi-step bash tasks? Need empirical data.
4. **Qwen3 vs Qwen2.5**: Does Qwen3's thinking mode help or hurt bash-first tool use? The README warns about multi-step issues.
5. **Tool output summarization**: Can we compress bash output to 2-3 sentences and preserve enough signal for 9B models?
6. **Cross-platform sandboxing**: No mature userspace sandbox on Windows — WSL2 + bubblewrap is the only viable path?

## Sources

[1] Vercel — "We removed 80% of our agents' tools" — https://vercel.com/blog/we-removed-80-percent-of-our-agents-tools (2025-12-12, accessed 2026-07-16)
[2] DoDataThings — "Agent Unix Philosophy" — https://dodatathings.dev/blog/agent-unix-philosophy (2026-03-30, accessed 2026-07-16)
[3] NVIDIA — "Improving Bash Generation in Small Language Models with Grammar-Constrained Decoding" — https://developer.nvidia.com/blog/improving-bash-generation-in-small-language-models-with-grammar-constrained-decoding/ (2026-05-08, accessed 2026-07-16)
[4] The New Stack — "The Key to Agentic Success: Let Unix/Bash Lead the Way" — https://thenewstack.io/the-key-to-agentic-success-let-unix-bash-lead-the-way/ (2026-01-12, accessed 2026-07-16)
[5] Korny — "The Power of the Unix Philosophy for LLM Agentic Tools" — https://blog.korny.info/2025/07/11/the-power-of-the-unix-philosophy-for-llm-agentic-tools (2025-07-11, accessed 2026-07-16)
[6] arXiv 2601.11672 — "Unix Philosophy in Agentic AI" — https://arxiv.org/abs/2601.11672 (2026-01-16, accessed 2026-07-16)
[7] Claude Code Docs — Tools — https://code.claude.com/docs/en/tools (accessed 2026-07-16)
[8] Claude Code Docs — Permissions — https://code.claude.com/docs/en/permissions (accessed 2026-07-16)
[9] Claude Code Docs — Sandboxing — https://code.claude.com/docs/en/sandboxing (accessed 2026-07-16)
[10] Claude Code Docs — Hooks Guide — https://code.claude.com/docs/en/hooks-guide (accessed 2026-07-16)
[11] OpenCode Source — tool.ts — https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/tool.ts (accessed 2026-07-16)
[12] OpenCode Source — registry.ts — https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts (accessed 2026-07-16)
[13] OpenCode Source — read.ts — https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/read.ts (accessed 2026-07-16)
[14] OpenCode Docs — Custom Tools — https://opencode.ai/docs/custom-tools/ (2026-07-14, accessed 2026-07-16)
[15] OpenCode Docs — Agents — https://opencode.ai/docs/agents/ (2026-07-14, accessed 2026-07-16)
[16] AkitaOnRails — "AI Jail: Sandbox for AI Agents" — https://akitaonrails.com/en/2026/03/01/ai-jail-sandbox-for-ai-agents-from-shell-script-to-real-tool/ (2026-03-01, accessed 2026-07-16)
[17] DeepWiki — Hermes Agent Security — https://deepwiki.com/NousResearch/hermes-agent/5.4-security-and-command-approval (2026-07-09, accessed 2026-07-16)
[18] Claude Code Plugins — Hook Development — https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/references/migration.md (2026-07-09, accessed 2026-07-16)
[19] Claude Code Plugins — Dangerous RM Hook — https://github.com/anthropics/claude-code/blob/main/plugins/hookify/examples/dangerous-rm.local.md (2026-07-09, accessed 2026-07-16)
[20] siawkz/llm-sandbox — https://github.com/siawkz/llm-sandbox (2025-07-24, accessed 2026-07-16)
[21] Anderson Joseph — "How I Run LLM Agents in a Secure Nix Sandbox" — https://dev.to/andersonjoseph/how-i-run-llm-agents-in-a-secure-nix-sandbox-1899 (2026-01-03, accessed 2026-07-16)
[22] Amir Malik — "Code Sandboxes for LLM AI Agents" — https://amirmalik.net/2025/03/07/code-sandboxes-for-llm-ai-agents (2025-03-07, accessed 2026-07-16)
[23] LLM Sandbox (vndee) — https://context7.com/vndee/llm-sandbox/llms.txt (2025-07-09, accessed 2026-07-16)
[24] Anthropic — "Building Effective Agents" — https://www.anthropic.com/research/building-effective-agents (2024-12-19, accessed 2026-07-16)
[25] OpenAI — Latency Optimization — https://developers.openai.com/api/docs/guides/latency-optimization (2025, accessed 2026-07-16)
[26] OpenAI — Deployment Checklist (defer_loading) — https://developers.openai.com/api/docs/guides/deployment-checklist (2025, accessed 2026-07-16)
[27] LiteLLM — Programmatic Tool Calling — https://docs.litellm.ai/docs/providers/anthropic_programmatic_tool_calling (2025, accessed 2026-07-16)
[28] Anthropic Courses — Tool Use — https://github.com/anthropics/courses/blob/master/tool_use/02_your_first_simple_tool.ipynb (2024, accessed 2026-07-16)
[29] arXiv 2210.03629 — ReAct: Synergizing Reasoning and Acting — https://arxiv.org/abs/2210.03629 (2022-10-06, accessed 2026-07-16)
[30] Prompting Guide — Function Calling — https://www.promptingguide.ai/agents/function-calling (2025, accessed 2026-07-16)
[31] Prompting Guide — ReAct — https://www.promptingguide.ai/techniques/react (2025, accessed 2026-07-16)
[32] LangChain Docs — Agents — https://python.langchain.com/docs/modules/agents/agents (2025, accessed 2026-07-16)
[33] Prompting Guide — Context Engineering — https://www.promptingguide.ai/agents/context-engineering (2025, accessed 2026-07-16)
[34] Prompting Guide — Agent Components — https://www.promptingguide.ai/agents/components (2025, accessed 2026-07-16)
[35] HuggingFace Blog — "Structured CodeAgent" — https://huggingface.co/blog/structured-codeagent (2025-05-28, accessed 2026-07-16)
[36] Qwen Blog — Qwen2.5 — https://qwenlm.github.io/blog/qwen2.5/ (2024-09-19, accessed 2026-07-16)
[37] arXiv 2307.03172 — Lost in the Middle — https://arxiv.org/abs/2307.03172 (2023-11-20, accessed 2026-07-16)
[38] arXiv 2408.00118 — Gemma 2 — https://arxiv.org/abs/2408.00118 (2024-07-31, accessed 2026-07-16)
[39] HuggingFace Docs — Chat Templating (continue_final_message) — https://huggingface.co/docs/transformers/main/en/chat_templating (accessed 2026-07-16)
[40] arXiv 2402.01030 — CodeAct — https://arxiv.org/abs/2402.01030 (2024-02-01, accessed 2026-07-16)
[41] Aider Source — base_coder.py — https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py (2024-2026, accessed 2026-07-16)
[42] HuggingFace — Qwen2.5-7B-Instruct — https://huggingface.co/Qwen/Qwen2.5-7B-Instruct (2024-09, accessed 2026-07-16)
[43] Qwen3 README — https://github.com/QwenLM/Qwen3/blob/main/README.md (2025-04-29, accessed 2026-07-16)
[44] arXiv 2310.03714 — DSPy — https://arxiv.org/abs/2310.03714 (2023-10-05, accessed 2026-07-16)
