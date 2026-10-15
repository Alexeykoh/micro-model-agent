import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { probeModel, getLoadedContextLength } from "../../src/llm/model-loader";

describe("probeModel", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reads vision + tools capabilities from the native API", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          {
            key: "qwen/qwen3.5-9b",
            max_context_length: 131072,
            loaded_instances: [{ config: { context_length: 34048 } }],
            capabilities: { vision: true, trained_for_tool_use: true },
          },
        ],
      }),
    })) as any;

    const probe = await probeModel("http://localhost:1234/v1", "qwen/qwen3.5-9b");
    expect(probe).toEqual({
      model: "qwen/qwen3.5-9b",
      contextLength: 34048,
      capabilities: { vision: true, tools: true },
    });
  });

  it("leaves capabilities undefined when the backend omits them", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [{ key: "m", max_context_length: 65536, loaded_instances: [] }],
      }),
    })) as any;

    const probe = await probeModel("http://localhost:1234/v1", "m");
    expect(probe).toEqual({ model: "m", contextLength: 65536, capabilities: undefined });
  });

  it("maps only the fields the backend reports", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          {
            key: "vl-only",
            max_context_length: 8192,
            capabilities: { vision: false },
          },
        ],
      }),
    })) as any;

    const probe = await probeModel("http://localhost:1234/v1", "vl-only");
    expect(probe?.capabilities).toEqual({ vision: false });
  });

  it("returns null when the model is not found", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ models: [{ key: "other" }] }),
    })) as any;

    const probe = await probeModel("http://localhost:1234/v1", "missing");
    expect(probe).toBeNull();
  });

  it("reads the reasoning off-switch from the native API (D2 discovery)", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          {
            key: "qwen/qwen3.5-9b",
            loaded_instances: [{ config: { context_length: 34048 } }],
            capabilities: {
              vision: true,
              trained_for_tool_use: true,
              reasoning: { allowed_options: ["off", "on"], default: "on" },
            },
          },
        ],
      }),
    })) as any;

    const probe = await probeModel("http://localhost:1234/v1", "qwen/qwen3.5-9b");
    expect(probe?.capabilities).toEqual({
      vision: true,
      tools: true,
      reasoningStrategy: "openai-effort",
      reasoningOff: true,
    });
  });

  it("omits the reasoning strategy when the endpoint does not advertise off", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          {
            key: "on-only",
            max_context_length: 8192,
            capabilities: { vision: false, reasoning: { allowed_options: ["on"], default: "on" } },
          },
        ],
      }),
    })) as any;

    const probe = await probeModel("http://localhost:1234/v1", "on-only");
    expect(probe?.capabilities).toEqual({ vision: false });
  });

  it("getLoadedContextLength projects probeModel to the legacy shape", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          {
            key: "qwen/qwen3.5-9b",
            max_context_length: 131072,
            loaded_instances: [{ config: { context_length: 32768 } }],
            capabilities: { vision: true },
          },
        ],
      }),
    })) as any;

    const probe = await getLoadedContextLength("http://localhost:1234/v1", "qwen/qwen3.5-9b");
    expect(probe).toEqual({ model: "qwen/qwen3.5-9b", actual: 32768 });
  });
});
