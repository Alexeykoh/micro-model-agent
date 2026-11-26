// LM-4: отказы tool call на локальной модели — совет про харнесс, а не «модель тупит».
import { describe, it, expect } from "vitest";
import { toolcallParserHint } from "../../src/modules/recovery/toolcall-hint";

describe("toolcall parser hint", () => {
  const base = { model: "qwen3.8-27b-uncensored", providerType: "openai-compat", failures: 3 };

  it("fires after three parse-like failures on a local Qwen", () => {
    const hint = toolcallParserHint({ ...base, error: "invalid tool_call arguments" });
    expect(hint).toBeTruthy();
    expect(hint).toContain("qwen3_coder");
    expect(hint).toContain("chat-template");
    expect(hint).toContain("Q4");
  });

  it("stays silent below the threshold and for non-parse errors", () => {
    expect(toolcallParserHint({ ...base, failures: 2, error: "invalid arguments" })).toBeUndefined();
    expect(toolcallParserHint({ ...base, error: "ENOENT file not found" })).toBeUndefined();
  });

  it("stays silent for non-local providers", () => {
    expect(toolcallParserHint({ ...base, providerType: "anthropic", error: "invalid arguments" })).toBeUndefined();
  });
});
