// src/modules/providers/presets.ts
import { OpenAICompatProvider, type RetryConfig } from "../../llm/openai-compat";
import type { RateLimitConfig } from "../../config/types";
import type { ProviderOptions, ProviderSpec } from "./types";

/** Build an OpenAI-compatible provider (default for most backends). */
function openaiCompat(opts: ProviderOptions) {
  const retry = (opts.retry ?? {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
  }) as RetryConfig;
  const rateLimits = opts.rateLimits as RateLimitConfig | undefined;
  return new OpenAICompatProvider({
    model: opts.model,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    contextWindow: opts.contextWindow,
    retry,
    rateLimits,
    maxCompletionTokens: opts.maxCompletionTokens,
    logger: opts.logger,
  });
}

const OPENAI_COMPAT: ProviderSpec = {
  type: "openai-compat",
  label: "OpenAI-compatible (LM Studio, Ollama, vLLM, etc.)",
  baseUrl: "",
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoningStrategy: "prompt-tag",
    listModels: true,
    requiresKey: false,
    auth: "bearer",
  },
  create: openaiCompat,
};

const OPENROUTER: ProviderSpec = {
  type: "openrouter",
  label: "OpenRouter (openrouter.ai)",
  baseUrl: "https://openrouter.ai/api/v1",
  capabilities: {
    streaming: true,
    tools: true,
    vision: true,
    reasoningStrategy: "openai-effort",
    listModels: true,
    requiresKey: true,
    auth: "bearer",
  },
  create: openaiCompat,
};

const OPENAI: ProviderSpec = {
  type: "openai",
  label: "OpenAI API",
  baseUrl: "https://api.openai.com/v1",
  capabilities: {
    streaming: true,
    tools: true,
    vision: true,
    reasoningStrategy: "openai-effort",
    listModels: true,
    requiresKey: true,
    auth: "bearer",
  },
  create: openaiCompat,
};

const ANTHROPIC: ProviderSpec = {
  type: "anthropic",
  label: "Anthropic Claude",
  baseUrl: "https://api.anthropic.com",
  capabilities: {
    streaming: false,
    tools: false,
    vision: true,
    reasoningStrategy: "none",
    listModels: false,
    requiresKey: true,
    auth: "header",
  },
  // The Anthropic messages API is NOT OpenAI-compatible. This preset is a
  // placeholder until a real AnthropicProvider lands; the factory still uses
  // the OpenAI-compatible code path today (broken), flagged via capabilities.
  create: openaiCompat,
};

const OPENCODE_ZEN: ProviderSpec = {
  type: "opencode-zen",
  label: "OpenCode Zen (opencode.ai/zen)",
  baseUrl: "https://opencode.ai/zen/v1",
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoningStrategy: "openai-effort",
    listModels: true,
    requiresKey: false,
    auth: "bearer",
  },
  create: openaiCompat,
};

const OPENCODE_GO: ProviderSpec = {
  type: "opencode-go",
  label: "OpenCode Go (opencode.ai/go)",
  baseUrl: "https://opencode.ai/zen/go/v1",
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    reasoningStrategy: "openai-effort",
    listModels: true,
    requiresKey: false,
    auth: "bearer",
  },
  create: openaiCompat,
};

/** All builtin provider presets. */
export const BUILTIN_PROVIDERS: ProviderSpec[] = [
  OPENAI_COMPAT,
  OPENROUTER,
  OPENAI,
  ANTHROPIC,
  OPENCODE_ZEN,
  OPENCODE_GO,
];

/** Fixed base URLs for hosted providers (no port scan / model autodetect). */
export const HOSTED_BASE_URLS: Record<string, string> = {};
for (const spec of BUILTIN_PROVIDERS) {
  if (spec.baseUrl) HOSTED_BASE_URLS[spec.type] = spec.baseUrl;
}