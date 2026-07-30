import type { AppConfig } from "./types";

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
  maxToolIterations: 25,
  stuckThreshold: 8,
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
    viewportWidth: 1280,
    viewportHeight: 720,
    navigationTimeout: 15000,
  },
  mcpServers: {
    context7: {
      name: "context7",
      transport: "sse",
      url: "https://mcp.context7.com/mcp",
      headers: {
        CONTEXT7_API_KEY: "ctx7sk-f3dd1f44-bc3a-4f6b-94c0-87cacb6c084b",
      },
      enabled: true,
      timeout: 30000,
    },
  },
};
