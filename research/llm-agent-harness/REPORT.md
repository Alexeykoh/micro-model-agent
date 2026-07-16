# LLM Agent Harness in TypeScript/Node.js — Landscape Research Report

**Date:** 2026-07-16  
**Sources:** 72+ findings across 8 research angles, 15+ primary sources, 6 arXiv papers

---

## Executive Summary

Building an LLM agent harness for small models (32K-64K context) in TypeScript/Node.js is well-supported by the current ecosystem. The key insight: **the Vercel AI SDK (v7) is the strongest foundation** — it provides multi-provider abstraction, tool calling, streaming, MCP integration, agent loops, and even a new "Harnesses" abstraction. Combined with the `openai` npm package for OpenAI-compatible backends (Ollama, vLLM, Together), you get broad provider coverage with minimal glue code.

For small models specifically, the research reveals a critical architectural decision: **avoid structured JSON tool calling for models under ~32B parameters**. Code-based action patterns (CodeAct) outperform JSON tool calling by up to 20%. The "structure tax" means small models break when forced to simultaneously handle JSON formatting + problem-solving. Your harness should use plain markdown code blocks as the primary action format.

---

## 1. OpenCode Architecture

**Two incarnations matter:**

- **Go version** (now `charmbracelet/crush`, 26.6k stars): Modular architecture with `internal/llm/provider/` (8 provider files), `internal/llm/tools/` (12 tools as separate files + MCP merge), `internal/llm/agent` (three-agent pattern: coder/task/title). [1]
- **TypeScript version** (opencode.ai by Anomaly, 160k+ stars): npm-distributed, 75+ providers via Models.dev. [1]

**Key architectural patterns:**

- **Three-agent architecture**: `coder` (main), `task` (sub-tasks via `agent` tool), `title` (session titles, 80 token cap). Lightweight multi-agent without full orchestration overhead. [1]
- **Provider type system**: `openai` vs `openai-compat` distinction handles real pain point — OpenAI's API format differs from compatible providers in tool calling schema. [1]
- **Auto-compact at 95%**: Monitors token usage, triggers summarization when hitting 95% of context window, creates new session with summary. Critical pattern for 32K-64K models. [1]
- **Tool registry**: Each tool is a separate file, MCP tools merged at runtime under same permission model. [1]
- **LSP diagnostics-as-context**: High-value, low-cost way to improve code quality — inject language server errors/warnings into AI context. [1]

---

## 2. Claude Code / CLI Coding Agent Patterns

**The universal agentic loop:**

```
gather context → take action → verify results → repeat until done
```

This 3-phase cycle is identical across Claude Code SDK, Aider, and all CLI coding agents. [2]

**Key patterns:**

- **Subagents get fresh context windows**: Custom system prompts, limited tool access, return only summaries to parent. This is the pattern for context isolation. [2]
- **CLAUDE.md injected as user messages**: Not part of system prompt — important for understanding where context budget goes. [2]
- **Skills loaded on-demand**: Descriptions always in context, full content only loads when invoked. Keeps context lean. [2]
- **Hooks (PreToolUse, PostToolUse)**: Intercept tool calls at lifecycle events without consuming context — run in application process, not inside agent's context window. [2]
- **MCP tool schemas deferred**: Only tool names consume context until Claude uses a specific tool. Prevents hundreds of tools from eating context upfront. [2]
- **Effort levels**: low/medium/high/max — trade reasoning depth for token cost per turn. [2]
- **Aider's repo map**: Generates compact repository structure overview for codebase awareness without reading all files. Directly applicable to small-context harnesses. [2]

---

## 3. MCP (Model Context Protocol)

**Architecture:** Open JSON-RPC 2.0 protocol with client-server architecture. [3]

**Three core server primitives:**
- **Tools** (model-controlled): LLM discovers and invokes automatically. JSON Schema input definitions. [3]
- **Resources** (application-driven): Data sources identified by URIs. [3]
- **Prompts** (user-controlled): Slash command templates. [3]

**Transports:** STDIO (local process) and Streamable HTTP (remote + optional SSE). [3]

**TypeScript SDK (v2 beta):**
- Packages: `@modelcontextprotocol/server` + `@modelcontextprotocol/client` [3]
- Minimal server:
```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
server.registerTool('greet', {
  description: 'Greet someone by name',
  inputSchema: z.object({ name: z.string() })
}, async ({ name }) => ({
  content: [{ type: 'text', text: `Hello, ${name}!` }]
}));
```
- Tool and prompt schemas use Standard Schema (Zod v4, Valibot, ArkType compatible). [3]
- Lifecycle: capability negotiation handshake before any tool/resource interaction. [3]
- Stable release expected July 28, 2026 alongside 2026-07-28 spec. [3]

**For your harness:** MCP is optional but valuable for extensibility. The Vercel AI SDK has first-class MCP support (`mcpTools`). If you build your own, focus on STDIO transport for local tools.

---

## 4. AGENTS.md / Skills Patterns

**AGENTS.md is an open standard** (23k+ GitHub stars) — a markdown file in project root, like a README for agents. [4]

**Framework patterns:**

| Framework | Mechanism | Key Feature |
|-----------|-----------|-------------|
| **AGENTS.md** | Markdown in project root | Simple, open, predictable |
| **Cursor** | `.mdc` rule files | 4 activation modes: always, glob-match, description-match, @-mention |
| **Claude Code** | `CLAUDE.md` + skills | Skills loaded on-demand (descriptions always, content lazy) |
| **Microsoft Skills** | 175+ `SKILL.md` files | YAML frontmatter, category symlinks, `npx skills add` |
| **OpenCode** | Custom commands as `.md` | `$NAME` argument placeholders |

**Key design decisions:**

- **Rule precedence**: Team Rules > Project Rules > User Rules [4]
- **Nested AGENTS.md**: Subdirectories combine with more-specific taking precedence [4]
- **Plugin structure**: `plugin.json` + `commands/` + `agents/` + `skills/` + `hooks/` directories [4]
- **Hooks intercept behavior**: PreToolUse, SessionStart — run outside agent's context window [4]

**For your harness:** AGENTS.md-style instructions injected as user messages (after system prompt) is the proven pattern. Keep it simple: a single `AGENTS.md` at project root, loaded into context as the first user message.

---

## 5. Vercel AI SDK (v7)

**The strongest TypeScript LLM abstraction available.** Current version: v7. [5]

**Core APIs:**

```typescript
import { generateText, streamText, tool } from 'ai';
import { z } from 'zod';

// Simple generation
const { text } = await generateText({
  model: "openai/gpt-4o",
  prompt: "Hello"
});

// Tool calling with multi-step
const result = await generateText({
  model: "openai/gpt-4o",
  tools: {
    weather: tool({
      description: 'Get weather',
      inputSchema: z.object({ location: z.string() }),
      execute: async ({ location }) => ({ temp: 72 })
    })
  },
  stopWhen: isStepCount(5)
});
```

**Multi-provider support:** 18+ providers including OpenAI, Anthropic, Google, xAI, Azure, Bedrock, Groq, DeepInfra, Mistral, Together.ai, Fireworks, DeepSeek, Cerebras. [5]

**Agent features:**
- **Agent loop**: `generateText`/`streamText` with tools + `stopWhen` conditions [5]
- **Subagents**: Fresh context windows, limited tool access [5]
- **Memory**: `prepareStep` callback for context compaction via `pruneMessages` [5]
- **Tool approval**: Per-tool or generic approval functions [5]
- **MCP integration**: First-class `mcpTools` support [5]
- **Harnesses**: New `HarnessAgent` abstraction for established agent harnesses (Claude Code, Codex) [5]

**Context compaction built-in:**
```typescript
prepareStep: ({ messages }) => {
  if (estimateTokens(messages) > THRESHOLD) {
    return {
      messages: pruneMessages({
        messages,
        reasoning: 'all',
        toolCalls: 'before-last-3-messages',
        emptyMessages: 'remove'
      })
    };
  }
}
```

**Recommendation:** Use Vercel AI SDK as the primary abstraction. For OpenAI-compatible backends (Ollama, vLLM), use the `@ai-sdk/openai-compatible` provider or the OpenAI provider with custom `baseURL`.

---

## 6. OpenAI-Compatible API Patterns

**The lingua franca for small model providers.** Most providers expose `/v1/chat/completions` with OpenAI's schema. [6]

**Key pattern (from OpenAI docs):**
```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:11434/v1",  // Ollama
  // or: "http://localhost:8080/v1",     // llama.cpp
  // or: "https://api.together.xyz/v1",  // Together
});

const response = await client.chat.completions.create({
  model: "qwen3.5:9b",
  messages: [{ role: "user", content: "Hello" }],
  tools: [{ /* JSON schema tool definitions */ }]
});
```

**Common gotchas:**
- **`openai` vs `openai-compat` type distinction** (from Crush): OpenAI's API format differs from compatible providers in tool calling schema — some providers don't support `strict: true`, `tool_choice`, or parallel tool calls [1]
- **Tool calling varies by provider**: Ollama, vLLM, Together each have slightly different tool calling support. Some require specific model variants (e.g., `qwen3.5:9b-instruct`)
- **Streaming differences**: SSE format is generally compatible, but chunk structures may differ
- **Token counting**: Use `tiktoken` or provider-specific counters; local models may use different tokenizers

**Provider-specific notes:**
- **Ollama**: `http://localhost:11434/v1` — full chat completions compatibility, tool calling support varies by model
- **vLLM**: `http://localhost:8000/v1` — excellent OpenAI compatibility, good tool calling support
- **Together**: `https://api.together.xyz/v1` — good compatibility, supports many open models
- **Groq**: `https://api.groq.com/openai/v1` — fast inference, good compatibility

---

## 7. Context Management for Small Models (32K-64K)

**Context management is the #1 bottleneck, not model quality.** Naive eviction cuts task success by 34.7pp. [7]

**Research-backed techniques:**

### Reversible Elastic Management (ACE)
Maintains raw + compressed copies, dynamically assigns raw/abstract/drop per step. Outperforms both truncation and summarization. [7]

### Dependency-Graph Eviction (ContextWeaver)
Models logical dependencies between information blocks. Outperforms sliding-window while reducing reasoning steps and token usage. [7]

### Self-Managed Context (VISTA)
Training-free "proprioceptive dashboard" — expose per-block token usage, recency, access history to the model. Lifts small models from 22.7% to 50.7% success. [7]

### Tool Result Truncation (DADL)
Tool advertisement alone can consume 142K tokens. Fixed-size Code Mode interface reduces to 1K (142x reduction). [7]

### Dual-Process Memory (Episodic + Semantic)
Constant 10-message episodic window + growing semantic consolidation at ~3 tokens/message. Maintains 70-85% accuracy with 62% fewer tokens. [7]

### Practical patterns for your harness:
1. **Auto-compact at 90-95% context usage** (OpenCode pattern)
2. **Truncate tool results aggressively** — don't dump entire file contents; summarize
3. **Sliding window for conversation history** — keep last N messages, summarize older ones
4. **Repo map** (Aider pattern) — compact codebase overview instead of reading all files
5. **Lazy skill loading** — descriptions in context, content on-demand only

---

## 8. Tool Calling with Small Models

**Critical insight: the "structure tax" at ~32B parameters.** [8]

Models below ~32B parameters perform **worse** with structured JSON tool calling. The cognitive overhead of JSON formatting + problem-solving overwhelms them. [8]

**What works for small models:**

### CodeAct > JSON Tool Calling
- Up to 20% higher success rate across 17 LLMs [8]
- Models generate code (markdown code blocks) instead of JSON tool calls
- Format is closer to natural training data

### Simple Schema Design
- Fewer tools, simpler schemas [8]
- No deep nesting, no complex optional parameters
- Use enums to constrain valid values

### "Poka-Yoke" Tool Design (Anthropic)
- Use absolute paths instead of relative [8]
- Restrict valid values in schemas
- Make mistakes harder by design

### Tool Definition Quality
- Include examples, edge cases, boundaries in descriptions [8]
- Treat tool docs like system prompts — same level of engineering
- Keep formats close to natural text the model saw in training [8]

### Parsing Reliability
- Traces with first-call parsing errors succeed 21.3% less often [8]
- Parsing errors cascade — critical for small models that error-recover poorly
- Consider repair mechanisms (Vercel AI SDK has `repairToolCall`)

### Practical recommendations:
1. **For 3B-7B models**: Use code-based actions (markdown code blocks), not JSON tool calling
2. **For 14B models**: Simple JSON tool calling may work, but keep schemas flat
3. **For 32B+ models**: Full structured tool calling works well
4. **Always**: Include tool call examples in system prompt, use `repairToolCall` for error recovery

---

## Architecture Recommendations

### Recommended Stack

```
Vercel AI SDK v7          — multi-provider abstraction, tool calling, streaming, agents
├── @ai-sdk/openai        — OpenAI provider
├── @ai-sdk/anthropic     — Anthropic provider  
├── @ai-sdk/openai-compatible — Ollama, vLLM, Together, etc.
├── @modelcontextprotocol/server — MCP (optional, for extensibility)
└── zod                   — schema validation (required by AI SDK)
```

### Core Architecture

```
src/
├── index.ts              # CLI entry (commander)
├── agent/
│   ├── loop.ts           # ReAct loop: gather → act → verify → repeat
│   ├── context.ts        # Token budget management, auto-compact
│   └── memory.ts         # Persistent state (SQLite or flat files)
├── llm/
│   ├── provider.ts       # Provider abstraction (AI SDK or custom)
│   └── token-counter.ts  # tiktoken or provider-specific
├── tools/
│   ├── bash.ts           # Shell execution (primary tool)
│   ├── read.ts           # File reading
│   ├── write.ts          # File writing
│   ├── search.ts         # Code search (ripgrep)
│   └── registry.ts       # Tool registration + MCP merge
├── skills/
│   ├── loader.ts         # AGENTS.md + skill file loading
│   └── store.ts          # Skill registry
└── config/
    ├── config.ts         # Configuration management
    └── types.ts          # TypeScript types
```

### Key Design Decisions

1. **CodeAct over JSON tool calling** for small models — use markdown code blocks as primary action format
2. **Auto-compact at 90% context** — summarize older messages, keep recent exchanges
3. **Tool result truncation** — never dump full file contents; summarize or paginate
4. **Lazy skill loading** — descriptions in context, content on-demand
5. **MCP as optional extension** — not core to the harness, but valuable for ecosystem
6. **Provider abstraction via AI SDK** — don't roll your own; use the battle-tested abstraction

---

## Open Questions

1. What are actual benchmark numbers for 3B-7B models on tool-call success rate vs 14B+?
2. How does context management strategy change when the model itself is weaker?
3. What is the latency/overhead tradeoff of dependency graph annotation vs simple sliding window?
4. How do Ollama-hosted small models handle OpenAI-compatible function calling in practice?
5. What fine-tuning datasets exist for tool-calling in small models (Gorilla, ToolLLaMA)?

---

## Sources

[1] F1.md — OpenCode Architecture. GitHub: opencode-ai/opencode, charmbracelet/crush, opencode.ai.  
[2] F2.md — Claude Code / CLI Patterns. Anthropic docs (code.claude.com), Aider source code.  
[3] F3.md — MCP Protocol. modelcontextprotocol.io, GitHub: modelcontextprotocol/typescript-sdk.  
[4] F4.md — AGENTS.md / Skills. agentsmd/agents.md, Cursor docs, Microsoft Skills repo.  
[5] Vercel AI SDK v7 docs. sdk.vercel.ai.  
[6] OpenAI Function Calling docs. platform.openai.com.  
[7] F7.md — Context Management. arXiv: 2606.22953, 2606.31564, 2606.11213, 2606.30005, 2604.23069, 2604.05400, 2605.05247, 2606.04315, 2604.10352, 2605.17625, 2605.29270.  
[8] F8.md — Tool Calling Small Models. Anthropic "Building Effective Agents", HuggingFace blog, ICML 2024 paper (arXiv:2402.01030).
