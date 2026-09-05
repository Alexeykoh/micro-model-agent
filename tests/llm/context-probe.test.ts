import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { getLoadedContextLength } from "../../src/llm/model-loader";

describe("getLoadedContextLength", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the loaded instance context_length", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [
          {
            key: "qwen/qwen3.5-9b",
            max_context_length: 131072,
            loaded_instances: [{ config: { context_length: 32768 } }],
          },
        ],
      }),
    })) as any;

    const probe = await getLoadedContextLength("http://localhost:1234/v1", "qwen/qwen3.5-9b");
    expect(probe).toEqual({ model: "qwen/qwen3.5-9b", actual: 32768 });
  });

  it("falls back to max_context_length when no instance is loaded", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({
        models: [{ key: "m", max_context_length: 65536, loaded_instances: [] }],
      }),
    })) as any;

    const probe = await getLoadedContextLength("http://localhost:1234/v1", "m");
    expect(probe).toEqual({ model: "m", actual: 65536 });
  });

  it("returns null when the model is not found", async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ models: [{ key: "other" }] }),
    })) as any;

    const probe = await getLoadedContextLength("http://localhost:1234/v1", "missing");
    expect(probe).toBeNull();
  });

  it("returns null when the endpoint is not LM Studio (404/error)", async () => {
    global.fetch = (async () => ({ ok: false })) as any;
    const probe = await getLoadedContextLength("http://localhost:9999/v1", "m");
    expect(probe).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    global.fetch = (async () => {
      throw new Error("connection refused");
    }) as any;
    const probe = await getLoadedContextLength("http://localhost:9999/v1", "m");
    expect(probe).toBeNull();
  });
});
