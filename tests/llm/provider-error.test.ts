import { describe, it, expect } from "vitest";
import { extractProviderErrorText } from "../../src/llm/provider-error";

describe("extractProviderErrorText", () => {
  it("keeps a plain string error (Ollama style)", () => {
    expect(extractProviderErrorText("model \"qwen\" not found")).toBe('model "qwen" not found');
  });

  it("reads message from an OpenAI-shaped error object", () => {
    // Реальный payload LM Studio: раньше превращался в "[object Object]" и
    // терял причину целиком (ses_muz7sg1l_0ankgu).
    const body = {
      error: {
        message:
          'Failed to load model "qwen/qwen3.5-9b". Error: Engine protocol startup was aborted.',
        type: "invalid_request_error",
        param: "model",
        code: null,
      },
    };
    expect(extractProviderErrorText(body.error)).toBe(
      'Failed to load model "qwen/qwen3.5-9b". Error: Engine protocol startup was aborted.',
    );
  });

  it("unwraps a nested { error: { message } }", () => {
    expect(extractProviderErrorText({ error: { message: "boom" } })).toBe("boom");
  });

  it("falls back to JSON for objects without a message", () => {
    const text = extractProviderErrorText({ foo: 1, bar: 2 });
    expect(text).toContain("foo");
    expect(text).not.toBe("[object Object]");
  });

  it("joins array errors and honours reason/detail/type", () => {
    expect(extractProviderErrorText(["a", "b"])).toBe("a; b");
    expect(extractProviderErrorText({ reason: "rate" })).toBe("rate");
    expect(extractProviderErrorText({ detail: "ctx" })).toBe("ctx");
    expect(extractProviderErrorText({ type: "server_error" })).toBe("server_error");
  });

  it("never returns an empty string", () => {
    expect(extractProviderErrorText(null)).toBe("unknown error");
    expect(extractProviderErrorText(undefined)).toBe("unknown error");
    // Пустой объект → компактный JSON (не "[object Object]" и не пусто).
    expect(extractProviderErrorText({})).toBe("{}");
  });

  it("truncates very long messages", () => {
    const text = extractProviderErrorText("x".repeat(5000));
    expect(text.length).toBeLessThanOrEqual(501);
    expect(text.endsWith("…")).toBe(true);
  });

  it("survives circular objects", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => extractProviderErrorText(circular)).not.toThrow();
  });
});
