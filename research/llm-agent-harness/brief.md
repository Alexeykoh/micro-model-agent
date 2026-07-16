# Research Brief: LLM Agent Harness in TypeScript/Node.js

## Date: 2026-07-16

## Refined Question
What are the key architectural patterns, libraries, and techniques for building a TypeScript/Node.js-based LLM agent harness optimized for small models (32K-64K context), with support for multi-provider LLM backends, tool calling, and context management?

## Audience
Solo developer / small team building a coding agent harness, likely for internal use or as an open-source project. Needs practical, implementation-focused guidance.

## Scope
- IN: TypeScript/Node.js agent frameworks, MCP protocol, Vercel AI SDK, small model optimization, tool calling patterns, context management
- OUT: Python-only frameworks, production deployment scaling, model training/fine-tuning, enterprise SaaS patterns

## Assumptions
- Target: small models (3B-14B parameters) with 32K-64K context windows
- Multi-provider support needed (OpenAI, Anthropic, Ollama, vLLM, Together, etc.)
- OpenAI-compatible API as the lingua franca
- TypeScript/Node.js as the primary runtime

## Angles

1. **OpenCode architecture** — open-source AI coding agent: architecture, tool calling, multi-provider support
2. **Claude Code / CLI coding agents** — architectural patterns, tool definitions, system prompts, context management
3. **MCP (Model Context Protocol)** — Anthropic's protocol, how it works, minimal server example
4. **AGENTS.md / skills patterns** — persistent instructions, skill systems in agent frameworks
5. **Vercel AI SDK** — multi-provider abstraction, tool calling, streaming
6. **OpenAI-compatible API patterns** — how small providers expose APIs, key integration patterns
7. **Context management for small models** — compression, sliding window, hierarchical summarization, tool result truncation
8. **Tool calling with small models** — structured definitions, simpler schemas, reliable patterns
