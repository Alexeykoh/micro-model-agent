import type { AppConfig } from "./types";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";

/** Single source of truth for the default model (experts inherit it, C8). */
const DEFAULT_MODEL = "qwen/qwen3.5-9b";

export const DEFAULTS: AppConfig = {
  version: "2.0.0",
  model: DEFAULT_MODEL,
  provider: {
    type: "openai-compat",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "not-needed",
  },
  orchestrator: {
    model: undefined,
    provider: undefined,
  },
  moe: {
    enabled: false,
    maxReplanCycles: 3,
  },
  tools: {
    // TODO(2026-08-29): revisit tool-set visibility. enableOnDemand:false
    // restores the full ~28-tool set (legacy behavior) — safe for small
    // models but costs schema tokens per call. The on-demand narrowing
    // (defaultTags + enable_tools) kept the footprint small but made the 9B
    // model call hidden tools as shell commands / drift to MCP. Decide the
    // right trade-off for small models and pick one mode.
    defaultTags: ["file", "code"],
    enableOnDemand: false,
  },
  experts: {
    code: {
      model: DEFAULT_MODEL,
      tool_tags: ["file", "code", "shell"],
      max_attempts: 3,
    },
    research: {
      model: DEFAULT_MODEL,
      tool_tags: ["research"],
      max_attempts: 3,
    },
    browser: {
      model: DEFAULT_MODEL,
      tool_tags: ["browser", "vision"],
      max_attempts: 3,
    },
    vision: {
      model: DEFAULT_MODEL,
      tool_tags: ["browser", "vision", "file"],
      max_attempts: 2,
    },
  },
  contextWindow: 32768,
  contextBudget: {
    systemPrompt: 0.1,
    responseReserve: 0.15,
    compactionThreshold: 0.75,
  },
  modelLoad: {
    autoLoad: false,
    flashAttention: true,
    offloadKvCacheToGpu: true,
  },
  retry: {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    maxStreamRetries: 2,
    noDataTimeoutMs: 180000,
  },
  maxToolIterations: 1000,
  stuckThreshold: 6,
  autoPlan: true,
  showReasoning: true,
  logLevel: "info",
  locale: "en",
  session: {
    autoSave: true,
    maxSessions: 50,
    isolateMemory: false,
  },
  browser: {
    enabled: true,
    headless: true,
    maxElements: 30,
    maxContentChars: 2500,
    maxConsoleEntries: 40,
    maxConsoleLineChars: 400,
    viewportWidth: 1280,
    viewportHeight: 720,
    navigationTimeout: 15000,
  },
  webSearch: {
    enabled: true,
  },
  errorWebSearch: {
    enabled: true,
    threshold: 5,
    maxResults: 5,
    maxQueryChars: 200,
    maxSearchesPerSession: 3,
    requestTimeoutMs: 10000,
  },
  pricing: {
    enabled: true,
    overrides: {},
  },
  ui: {
    spinner: true,
    showContextStats: false,
    showCompaction: true,
  },
  mcpServers: {
    context7: {
      name: "context7",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      headers: {
        CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY || "",
      },
      enabled: true,
      timeout: 30000,
    },
  },
  security: DEFAULT_SECURITY_CONFIG,
  sessionIsolation: {
    enabled: false,
    isolatePlugins: true,
    isolateTempFiles: true,
  },
  skills: {
    budget: 0.15,
  },
  hallucination: {
    judge: {
      enabled: false,
    },
  },
  subagent: {
    resultMode: "text",
    maxSummaryChars: 2000,
    artifactsDir: ".mma/artifacts",
    stableSystemPrompt: true,
    maxParallelChunkQueries: 4,
  },
  lsp: DEFAULT_LSP_CONFIG,
  updater: {
    enabled: true,
    checkOnStart: false,
    autoInstall: false,
    intervalMs: 0,
  },
  reasoning: {
    mode: "auto",
    min: "low",
    max: "high",
    overrideCooldown: 5,
  },
};
