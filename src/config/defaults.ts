import type { AppConfig } from "./types";
import { DEFAULT_SECURITY_CONFIG } from "./security";
import { DEFAULT_LSP_CONFIG } from "../modules/lsp/config";

export const DEFAULTS: AppConfig = {
  version: "2.0.0",
  model: "qwen3.5-9b",
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
  },
  experts: {
    code: {
      model: "qwen3.5-9b",
      tool_tags: ["file", "code", "shell"],
      max_attempts: 3,
    },
    research: { model: "qwen3.5-9b", tool_tags: ["research"], max_attempts: 3 },
    browser: {
      model: "qwen3.5-9b",
      tool_tags: ["browser", "vision"],
      max_attempts: 3,
    },
    vision: {
      model: "qwen3.5-9b",
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
  },
  maxToolIterations: 1000,
  stuckThreshold: 6,
  autoPlan: true,
  showReasoning: false,
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
  ui: {
    spinner: true,
    toolStyle: "inline",
    toolComments: true,
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
    checkOnStart: true,
    autoInstall: true,
    intervalMs: 0,
  },
};
