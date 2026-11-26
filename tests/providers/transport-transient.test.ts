// AQC-7: сетевой обрыв стрима — transient, а не «Ошибка LLM».
import { describe, it, expect } from "vitest";
import { isFailoverError } from "../../src/modules/providers/fallback";
import { isTransientNetworkFailure } from "../../src/llm/openai-stream";

describe("AQC-7: transient network failure", () => {
  it("распознаёт оба текста из живых сессий", () => {
    const messages = [
      "The socket connection was closed unexpectedly. For more information, pass `verbose: true`",
      "Unable to connect. Is the computer able to access the url?",
    ];
    for (const message of messages) {
      expect(isTransientNetworkFailure(message)).toBe(true);
      expect(isFailoverError(new Error(message))).toBe(true);
    }
  });

  it("не считает transient-ом отмену пользователя", () => {
    expect(isTransientNetworkFailure("aborted by user")).toBe(false);
    expect(isFailoverError(new Error("AbortError"))).toBe(false);
  });
});
