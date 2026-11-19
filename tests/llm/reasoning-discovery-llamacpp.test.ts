// Discovery механизма reasoning у локальных бэкендов (INV-R6/R7):
// llama.cpp объявляет его в /props.chat_template_caps, а не в пресете.
import { describe, it, expect, afterEach } from "vitest";
import {
  probeLlamaCppReasoning,
  probeNativeCapabilities,
} from "../../src/llm/model-loader";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubProps(props: unknown): void {
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/props")) {
      return new Response(JSON.stringify(props), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("llama.cpp reasoning discovery", () => {
  it("reads chat_template_caps and the off-switch", async () => {
    stubProps({
      chat_template_caps: {
        supports_reasoning_effort: true,
        reasoning_effort_levels: ["low", "medium", "xhigh"],
      },
    });
    expect(await probeLlamaCppReasoning("http://127.0.0.1:8080", 500)).toEqual({
      strategy: "openai-effort",
      reasoningOff: true,
      levels: ["low", "medium", "xhigh"],
    });
  });

  it("falls back to template-kwarg when the template has enable_thinking", async () => {
    stubProps({ chat_template: "{% if enable_thinking is undefined %}..." });
    expect(await probeLlamaCppReasoning("http://127.0.0.1:8080", 500)).toEqual({
      strategy: "template-kwarg",
      reasoningOff: true,
    });
  });

  it("returns null when the endpoint declares no mechanism", async () => {
    stubProps({ chat_template: "plain" });
    expect(await probeLlamaCppReasoning("http://127.0.0.1:8080", 500)).toBeNull();
  });

  it("probeNativeCapabilities merges llama.cpp caps before provider build", async () => {
    stubProps({
      chat_template_caps: {
        supports_reasoning_effort: true,
        reasoning_effort_levels: ["low", "medium", "xhigh"],
      },
    });
    const probe = await probeNativeCapabilities("http://127.0.0.1:8080/v1", "qwen3.8-27b", 500);
    expect(probe?.capabilities).toMatchObject({
      reasoningStrategy: "openai-effort",
      reasoningOff: true,
      reasoningLevels: ["low", "medium", "xhigh"],
    });
  });

  it("asks llama-swap with a model id when bare /props is rejected", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("model=qwen3.8-27b-uncensored&autoload=false")) {
        return new Response(
          JSON.stringify({
            chat_template_caps: {
              supports_reasoning_effort: true,
              reasoning_effort_levels: ["low", "medium", "xhigh"],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // llama-swap: голый `/props` без id модели — 404.
      return new Response("no model id could be identified", { status: 404 });
    }) as typeof fetch;

    expect(await probeLlamaCppReasoning("http://127.0.0.1:8080", 500, "qwen3.8-27b-uncensored"))
      .toEqual({
        strategy: "openai-effort",
        reasoningOff: true,
        levels: ["low", "medium", "xhigh"],
      });
    expect(urls[0]).toBe("http://127.0.0.1:8080/props");
    expect(urls[1]).toContain("model=qwen3.8-27b-uncensored");
    expect(urls[1]).toContain("autoload=false");
  });
});
