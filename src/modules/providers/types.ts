// src/modules/providers/types.ts
import type { LLMProvider } from "../../llm/provider";
import type { RetryConfig } from "../../config/types";
import type { RateLimitConfig } from "../../config/types";
import type { ReasoningStrategy } from "../../config/types";

/**
 * What a provider advertises it supports. The agent loop uses these to adapt
 * (e.g. skip `reasoning_effort` for backends that reject it, refuse a model
 * with no `apiKey` configured, etc.).
 */
export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  /** How this provider expresses reasoning effort. */
  reasoningStrategy: ReasoningStrategy;
  listModels: boolean;
  requiresKey: boolean;
  auth?: "bearer" | "header";
}

/** Options passed to a provider factory. */
export interface ProviderOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  /** Per-call completion cap (max_tokens). Default 4096 in openai-compat. */
  maxCompletionTokens?: number;
  capabilities?: Partial<ProviderCapabilities>;
  /** Live conversation id, sent as `x-opencode-session` when present. */
  getSessionId?: () => string | undefined;
  /** Optional logger for LLM request/response diagnostics. */
  logger?: import("../../logger/app-logger").Logger;
}

/** A registered provider: metadata + a factory that builds the LLMProvider. */
export interface ProviderSpec {
  type: string;
  label: string;
  /** Preset default base URL. Empty string = the user must enter it. */
  baseUrl: string;
  capabilities: ProviderCapabilities;
  create: (opts: ProviderOptions) => LLMProvider;
}