# Research Brief: Optimizing LLM Agent Performance with Small Models (7B-9B)

> Generated 2026-07-16 · depth: deep · target: 25+ sources

## Question

What are the best techniques for building reliable AI coding agents using small LLMs (7B-9B parameter range: Qwen 2.5/3, Llama 3.x, Mistral)? Cover prompt engineering, context management, tool calling, agent loop design, fine-tuning, and real-world open-source projects.

## Scope boundaries

**In:**
- Models in 7B-9B parameter range (Qwen 2.5-7B/9B, Llama 3.1-8B/3.2-3B, Mistral 7B, Phi-3/4)
- Context windows 32K-64K tokens
- Coding agent use cases (tool use, multi-step reasoning, code generation)
- Prompt engineering, context optimization, tool calling, agent loop design
- Fine-tuning and prompt caching
- Open-source projects designed for small-model agents
- Qwen-specific chat templates and tool formats

**Out:**
- Models >13B parameters (covered separately)
- Non-coding agent use cases (chatbots, RAG-only)
- Proprietary model-specific optimizations
- Hardware/quantization details (separate topic)

## Assumptions

- Target deployment: self-hosted or local inference (vLLM, llama.cpp, Ollama)
- Framework-agnostic: any agent framework (LangChain, smolagents, custom)
- Primary goal: reliability and accuracy, not just speed

## Angles

1. Prompt engineering for small models (system prompt structure, tool definitions, response formatting)
2. Context window optimization (compression, summarization, priority ordering, token counting)
3. Tool calling reliability (JSON generation, structured output, constrained decoding)
4. Agent loop design (simpler loops, hallucination prevention, reflection patterns)
5. Fine-tuning and prompt caching for small models
6. Open-source coding agents for small models (OpenHands, Aider, Continue.dev, smolagents, etc.)
7. Qwen-specific tips (chat templates, tool calling formats, model-specific behaviors)
