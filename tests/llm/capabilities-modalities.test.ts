// Universal modality discovery across providers: opencode-go/zen, OpenRouter,
// llama.cpp, Ollama and generic OpenAI-compatible `/models`. Each backend
// declares media input in a different shape; the probe must understand all of
// them and never claim `false` on silence.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  declaredMediaCapabilities,
  declaredMediaModalities,
  declaresVision,
  probeOpenAICompatCapabilities,
} from "../../src/llm/openai-compat-models";
import { probeNativeCapabilities } from "../../src/llm/model-loader";
import { probeLlamaCppModalities, probeOllamaCapabilities } from "../../src/llm/native-context";

type Route = (url: string, init?: RequestInit) => unknown | undefined;

function stubFetch(route: Route): void {
  global.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = route(String(url), init);
    if (body === undefined || body === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("declaredMediaCapabilities", () => {
  it("reads OpenCode Zen/Go `modalities.input` with MIME strings", () => {
    expect(
      declaredMediaCapabilities({
        modalities: {
          input: ["text", "image/png", "image/jpeg", "video/mp4"],
          output: ["text"],
        },
      }),
    ).toEqual({ vision: true, video: true });
  });

  it("reads OpenRouter `architecture.input_modalities` and tool_call", () => {
    expect(
      declaredMediaCapabilities({
        architecture: { input_modalities: ["text", "image", "file"] },
        tool_call: true,
      }),
    ).toEqual({ vision: true, tools: true });
  });

  it("reads llama.cpp capability arrays (`multimodal`, `tools`)", () => {
    expect(declaredMediaCapabilities({ capabilities: ["completion", "multimodal", "tools"] })).toEqual(
      { vision: true, tools: true },
    );
  });

  it("reads LM Studio capability objects", () => {
    expect(
      declaredMediaCapabilities({ capabilities: { vision: true, tools: { supported: true } } }),
    ).toEqual({ vision: true, tools: true });
  });

  it("maps audio and PDF input tokens", () => {
    expect(declaredMediaCapabilities({ modalities: { input: ["audio/wav", "application/pdf"] } })).toEqual(
      { audio: true, pdf: true },
    );
  });

  it("returns nothing when the backend stays silent (unknown ≠ unsupported)", () => {
    expect(declaredMediaCapabilities({ id: "bare-model" })).toEqual({});
    expect(declaredMediaModalities({ id: "bare-model" }).size).toBe(0);
    expect(declaresVision({ id: "bare-model" })).toBe(false);
  });
});

describe("probeOpenAICompatCapabilities over real shapes", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("detects vision + video from an opencode-go `/models` answer", async () => {
    stubFetch((url) =>
      url.endsWith("/v1/models")
        ? {
            data: [
              {
                id: "qwen3.8-flash",
                modalities: {
                  input: ["text", "image/png", "image/jpeg", "video/mp4"],
                  output: ["text"],
                },
              },
            ],
          }
        : undefined,
    );
    const probe = await probeOpenAICompatCapabilities(
      "https://opencode.ai/zen/go/v1",
      "qwen3.8-flash",
      "k",
      500,
    );
    expect(probe).toMatchObject({
      reachable: true,
      capabilities: { vision: true, video: true },
    });
  });

  it("detects image+pdf from a models.dev-style `modalities.input`", async () => {
    stubFetch(() => ({
      data: [{ id: "doc-model", modalities: { input: ["text", "image/jpeg", "application/pdf"] } }],
    }));
    const probe = await probeOpenAICompatCapabilities("https://host/v1", "doc-model", undefined, 500);
    expect(probe.capabilities).toEqual({ vision: true, pdf: true });
  });
});

describe("native modality probes", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reads Ollama `/api/show.capabilities`", async () => {
    stubFetch((url, init) =>
      url.endsWith("/api/show") && init?.method === "POST"
        ? { capabilities: ["completion", "tools", "vision"] }
        : undefined,
    );
    expect(await probeOllamaCapabilities("http://localhost:11434", "qwen3:8b", 500)).toEqual({
      vision: true,
      tools: true,
    });
  });

  it("reads llama.cpp `/props.modalities` booleans", async () => {
    stubFetch((url) =>
      url.endsWith("/props")
        ? { modalities: { vision: true, video: false, audio: true }, chat_template: "plain" }
        : undefined,
    );
    expect(await probeLlamaCppModalities("http://localhost:8080", 500)).toEqual({
      vision: true,
      audio: true,
    });
  });

  it("merges Ollama and llama.cpp declarations in probeNativeCapabilities", async () => {
    stubFetch((url, init) => {
      if (url.endsWith("/props")) return { modalities: { vision: true, video: true } };
      if (url.endsWith("/api/show") && init?.method === "POST") return { capabilities: ["vision"] };
      return undefined;
    });
    const probe = await probeNativeCapabilities(
      "http://localhost:8080/v1",
      "qwen3.8-27b",
      500,
      "openai-compat",
    );
    expect(probe?.capabilities).toMatchObject({ vision: true, video: true });
  });
});
